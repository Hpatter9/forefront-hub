import RoomPlan
import SwiftUI
import UIKit

/// Apple's own room scanner (RoomPlan): it shows the outline of walls, doors and windows as you walk the room. Done
/// stops it, Apple tidies the result, and the room comes back to the app.
final class CaptureController: UIViewController, RoomCaptureViewDelegate {
  private var captureView: RoomCaptureView!
  private let config = RoomCaptureSession.Configuration()
  private var finished: CapturedRoom?
  private var stopping = false
  var onFinish: ((CapturedRoom?) -> Void)?

  private lazy var doneButton: UIButton = button("Done with this room", .systemBlue) { [weak self] in self?.done() }
  private lazy var cancelButton: UIButton = button("Cancel", .systemGray) { [weak self] in self?.cancel() }

  override init(nibName: String?, bundle: Bundle?) { super.init(nibName: nibName, bundle: bundle) }
  required init?(coder: NSCoder) { super.init(coder: coder) }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    captureView = RoomCaptureView(frame: view.bounds)
    captureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    captureView.delegate = self
    view.addSubview(captureView)
    let bar = UIStackView(arrangedSubviews: [cancelButton, doneButton])
    bar.axis = .horizontal; bar.spacing = 12; bar.distribution = .fillProportionally
    bar.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(bar)
    NSLayoutConstraint.activate([
      bar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
      bar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
      bar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
      bar.heightAnchor.constraint(equalToConstant: 56),
    ])
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    captureView.captureSession.run(configuration: config)
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    if !stopping { captureView.captureSession.stop() }
  }

  private func button(_ title: String, _ color: UIColor, _ action: @escaping () -> Void) -> UIButton {
    var c = UIButton.Configuration.filled()
    c.title = title; c.baseBackgroundColor = color; c.cornerStyle = .large
    c.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { var a = $0; a.font = .boldSystemFont(ofSize: 19); return a }
    return UIButton(configuration: c, primaryAction: UIAction { _ in action() })
  }

  private func done() {
    if let room = finished { onFinish?(room); return }
    stopping = true
    doneButton.isEnabled = false
    doneButton.configuration?.title = "Working out the room…"
    captureView.captureSession.stop()
  }

  private func cancel() {
    stopping = true
    captureView.captureSession.stop()
    onFinish?(nil)
  }

  // Apple asks whether to tidy up the raw scan (yes), then hands back the finished room.
  func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool { true }

  func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
    finished = processedResult
    doneButton.isEnabled = true
    doneButton.configuration?.title = error == nil ? "Use this room" : "Use it anyway"
  }
}

struct CaptureScreen: UIViewControllerRepresentable {
  var onFinish: (CapturedRoom?) -> Void
  func makeUIViewController(context: Context) -> CaptureController {
    let c = CaptureController(nibName: nil, bundle: nil)
    c.onFinish = onFinish
    return c
  }
  func updateUIViewController(_ c: CaptureController, context: Context) { c.onFinish = onFinish }
}
