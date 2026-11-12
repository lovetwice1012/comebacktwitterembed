// Read-only diagnostics for the synthetic Safari session on a disposable runner.
// Never print accessibility strings, browser identifiers, or window contents.
import AppKit
import ApplicationServices
import Foundation

let env = ProcessInfo.processInfo.environment
guard env["GITHUB_ACTIONS"] == "true", env["RUNNER_ENVIRONMENT"] == "github-hosted",
      env["CBTE_SAFARI_PUSH_HOSTED"] == "1" else {
    print("diagnostic=unknown")
    exit(1)
}

func safariApps() -> [NSRunningApplication] {
    NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").filter { !$0.isTerminated }
}

if CommandLine.arguments.dropFirst().first == "baseline" {
    print(safariApps().isEmpty ? "baseline=clean" : "baseline=not_clean")
    exit(0)
}
guard CommandLine.arguments.dropFirst().first == "inspect", AXIsProcessTrusted() else {
    print("diagnostic=unknown")
    exit(0)
}
let apps = safariApps()
guard apps.count == 1 else { print("diagnostic=unknown"); exit(0) }
let app = AXUIElementCreateApplication(apps[0].processIdentifier)
AXUIElementSetMessagingTimeout(app, 1.0)

var incomplete = false
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    if status == .success { return value }
    if status != .noValue && status != .attributeUnsupported { incomplete = true }
    return nil
}
func text(_ element: AXUIElement, _ name: String) -> String {
    (attribute(element, name) as? String) ?? ""
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    guard let value = attribute(element, kAXChildrenAttribute as String) else { return [] }
    guard let result = value as? [AXUIElement] else { incomplete = true; return [] }
    return result
}

guard let windows = attribute(app, kAXWindowsAttribute as String) as? [AXUIElement], windows.count == 1,
      let window = windows.first, text(window, kAXTitleAttribute as String) == "Push subscription fixture" else {
    print("diagnostic=unknown"); exit(0)
}

// Only a native sheet/dialog under the unique fixture window is considered.
// Bound traversal to avoid reading unrelated processes or an unbounded UI tree.
var queue: [(AXUIElement, Int)] = [(window, 0)]
var cursor = 0
var candidateDialogs: [AXUIElement] = []
while cursor < queue.count && cursor < 300 {
    let (node, depth) = queue[cursor]; cursor += 1
    let role = text(node, kAXRoleAttribute as String)
    if role == "AXSheet" || role == "AXDialog" { candidateDialogs.append(node) }
    // Web content is not a native browser permission dialog.
    if role == "AXWebArea" { continue }
    let nested = children(node)
    if nested.count > 100 || (depth >= 12 && !nested.isEmpty) { incomplete = true }
    if depth < 12 { queue.append(contentsOf: nested.prefix(100).map { ($0, depth + 1) }) }
}
if cursor < queue.count { incomplete = true }

var matchingDialogs = 0
for dialog in candidateDialogs {
    var nodes: [(AXUIElement, Int)] = [(dialog, 0)]
    var index = 0, origin = false, notification = false, allow = false, reject = false
    while index < nodes.count && index < 200 {
        let (node, depth) = nodes[index]; index += 1
        let role = text(node, kAXRoleAttribute as String)
        let pieces = [text(node, kAXTitleAttribute as String), text(node, kAXDescriptionAttribute as String),
                      text(node, kAXValueAttribute as String)]
        for piece in pieces {
            let value = piece.lowercased().replacingOccurrences(of: "’", with: "'")
            origin = origin || value.contains("127.0.0.1")
            notification = notification || value.contains("notification")
            if role == "AXButton" {
                allow = allow || value == "allow"
                reject = reject || value == "don't allow"
            }
        }
        let nested = children(node)
        if nested.count > 100 || (depth >= 12 && !nested.isEmpty) { incomplete = true }
        if depth < 12 { nodes.append(contentsOf: nested.prefix(100).map { ($0, depth + 1) }) }
    }
    if index < nodes.count { incomplete = true }
    if origin && notification && allow && reject { matchingDialogs += 1 }
}

// Anything ambiguous, inaccessible, truncated or differently localized is
// unknown. Even a fully traversed tree cannot prove that no prompt exists.
print(!incomplete && matchingDialogs == 1 ? "diagnostic=notification_prompt_present" : "diagnostic=unknown")
