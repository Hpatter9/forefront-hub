package com.forefront.keystone;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Keystone on the phone. The screen and the logic are the web page in assets/ (index.html + app.js); this class is
 * the thin layer under it: the network (so the page isn't held to a browser's cross-site limits), the microphone
 * (Android's own speech-to-text), reading answers aloud, and a private place on the phone for the keys.
 * The page is only ever loaded from inside the app; links to anywhere else open in the phone's own apps.
 */
public class MainActivity extends Activity {
  private static final int SPEECH = 7;
  private WebView web;
  private SharedPreferences prefs;
  private TextToSpeech tts;
  private boolean ttsReady;
  private String speechCallback;
  private final ExecutorService pool = Executors.newFixedThreadPool(4);

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    prefs = getSharedPreferences("keystone", MODE_PRIVATE);
    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setAllowFileAccess(true);
    s.setAllowContentAccess(false);
    web.setBackgroundColor(0xFF0A1C36);
    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
        // Only the app's own page runs here. Anything else (a phone number, an email, a web link) opens outside.
        if (r.getUrl().toString().startsWith("file:///android_asset/")) return false;
        open(r.getUrl().toString());
        return true;
      }
    });
    web.addJavascriptInterface(new Bridge(), "Native");
    setContentView(web);
    web.loadUrl("file:///android_asset/index.html");
    tts = new TextToSpeech(this, status -> {
      ttsReady = status == TextToSpeech.SUCCESS;
      if (ttsReady) tts.setLanguage(Locale.US);
    });
  }

  @Override
  protected void onDestroy() {
    if (tts != null) tts.shutdown();
    pool.shutdownNow();
    super.onDestroy();
  }

  @Override
  public void onBackPressed() {
    web.evaluateJavascript("window.onNativeBack ? window.onNativeBack() : false", handled -> {
      if (!"true".equals(handled)) moveTaskToBack(true);
    });
  }

  private void open(String url) {
    try {
      startActivity(new Intent(url.startsWith("tel:") ? Intent.ACTION_DIAL : Intent.ACTION_VIEW, Uri.parse(url)));
    } catch (ActivityNotFoundException e) {
      // nothing on the phone can open it
    }
  }

  /** Hands a result back to the page: window.nativeDone(id, json). */
  private void done(String id, JSONObject result) {
    final String js = "window.nativeDone(" + JSONObject.quote(id) + "," + result.toString() + ")";
    runOnUiThread(() -> web.evaluateJavascript(js, null));
  }

  private static JSONObject error(String message) {
    JSONObject o = new JSONObject();
    try { o.put("error", message == null ? "Something went wrong." : message); } catch (Exception ignored) { }
    return o;
  }

  private static String readAll(InputStream in) throws Exception {
    if (in == null) return "";
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
    return out.toString("UTF-8");
  }

  private static JSONObject request(String method, String url, JSONObject headers, String body) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    c.setRequestMethod(method);
    c.setConnectTimeout(15000);
    c.setReadTimeout(90000);
    c.setInstanceFollowRedirects(false);
    if (headers != null) for (Iterator<String> it = headers.keys(); it.hasNext(); ) { String k = it.next(); c.setRequestProperty(k, headers.getString(k)); }
    if (body != null && !"GET".equals(method)) {
      c.setDoOutput(true);
      try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes(StandardCharsets.UTF_8)); }
    }
    int status = c.getResponseCode();
    String text = readAll(status >= 400 ? c.getErrorStream() : c.getInputStream());
    c.disconnect();
    return new JSONObject().put("status", status).put("body", text);
  }

  @Override
  protected void onActivityResult(int code, int result, Intent data) {
    super.onActivityResult(code, result, data);
    if (code != SPEECH || speechCallback == null) return;
    String id = speechCallback;
    speechCallback = null;
    ArrayList<String> said = data == null ? null : data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
    try {
      done(id, new JSONObject().put("text", result == RESULT_OK && said != null && !said.isEmpty() ? said.get(0) : ""));
    } catch (Exception e) {
      done(id, error(e.getMessage()));
    }
  }

  private class Bridge {
    /** Any web request, made by the app itself. Only https, except the one-time setup fetch below. */
    @JavascriptInterface
    public void http(final String id, final String method, final String url, final String headersJson, final String body) {
      pool.execute(() -> {
        try {
          if (!url.startsWith("https://")) throw new Exception("Only secure (https) addresses are allowed.");
          done(id, request(method, url, headersJson == null || headersJson.isEmpty() ? null : new JSONObject(headersJson), body));
        } catch (Exception e) {
          done(id, error(e.getMessage()));
        }
      });
    }

    /**
     * Fetches this phone's setup from Keystone on the laptop (same Wi-Fi) and unlocks it with the code shown there.
     * The code itself is never sent: the laptop sends the setup locked with it, and only the right code opens it.
     */
    @JavascriptInterface
    public void pair(final String id, final String address, final String code) {
      pool.execute(() -> {
        try {
          String host = address.trim().replaceFirst("^https?://", "").replaceAll("/+$", "");
          if (!host.matches("[0-9A-Za-z.\\-]+(:\\d+)?")) throw new Exception("That doesn't look like the address Keystone showed.");
          JSONObject res = request("GET", "http://" + host + "/pair", null, null);
          if (res.getInt("status") != 200) throw new Exception("Keystone on the laptop isn't offering a connection right now. Double-click Connect phone again.");
          JSONObject box = new JSONObject(res.getString("body"));
          byte[] salt = Base64.decode(box.getString("salt"), Base64.DEFAULT);
          byte[] iv = Base64.decode(box.getString("iv"), Base64.DEFAULT);
          byte[] data = Base64.decode(box.getString("data"), Base64.DEFAULT);
          byte[] key = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(new PBEKeySpec(code.replaceAll("\\D", "").toCharArray(), salt, box.getInt("rounds"), 256)).getEncoded();
          Cipher aes = Cipher.getInstance("AES/GCM/NoPadding");
          aes.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
          String setup;
          try {
            setup = new String(aes.doFinal(data), StandardCharsets.UTF_8);
          } catch (Exception wrong) {
            throw new Exception("That code didn't match. Check the 6 digits on the laptop.");
          }
          new JSONObject(setup); // must be real setup
          prefs.edit().putString("setup", setup).apply();
          done(id, new JSONObject().put("ok", true));
        } catch (java.net.ConnectException | java.net.SocketTimeoutException | java.net.UnknownHostException e) {
          done(id, error("Couldn't reach the laptop. Make sure the phone is on the same Wi-Fi and the Connect phone window is still open."));
        } catch (Exception e) {
          done(id, error(e.getMessage()));
        }
      });
    }

    @JavascriptInterface
    public String get(String key) {
      return prefs.getString(key, "");
    }

    @JavascriptInterface
    public void set(String key, String value) {
      if (value == null || value.isEmpty()) prefs.edit().remove(key).apply();
      else prefs.edit().putString(key, value).apply();
    }

    /** Opens Android's speech-to-text; the words come back to the page. */
    @JavascriptInterface
    public void listen(final String id) {
      runOnUiThread(() -> {
        try {
          if (tts != null) tts.stop();
          Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
          i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
          i.putExtra(RecognizerIntent.EXTRA_PROMPT, "Tell Keystone");
          speechCallback = id;
          startActivityForResult(i, SPEECH);
        } catch (ActivityNotFoundException e) {
          speechCallback = null;
          done(id, error("This phone has no speech-to-text set up. Use the microphone key on the keyboard instead."));
        }
      });
    }

    @JavascriptInterface
    public void speak(String text) {
      if (ttsReady && text != null) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "keystone");
    }

    @JavascriptInterface
    public void quiet() {
      if (tts != null) tts.stop();
    }

    @JavascriptInterface
    public void open(final String url) {
      runOnUiThread(() -> MainActivity.this.open(url));
    }
  }
}
