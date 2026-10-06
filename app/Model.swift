// State shared by the menu and the window: what the emulator reports, plus the
// actions that change it. Talks to the emulator's local API on port 9900.

import Foundation
import Combine

let apiBase = URL(string: "http://127.0.0.1:9900")!

// MARK: - API types

struct AtemModelInfo: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let family: String
    let source: String      // recorded, derived or captured
    let from: String?
}

struct RouterModelInfo: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let inputs: Int
    let outputs: Int
}

struct ModelList: Decodable {
    let atem: [AtemModelInfo]
    let videohub: [RouterModelInfo]
}

struct ClientInfo: Decodable, Hashable { let address: String? }
struct Unhandled: Decodable, Hashable { let name: String; let count: Int }

struct SwitcherStatus: Decodable {
    let id: String
    let name: String
    let source: String
    let basedOn: String?
    let clients: [ClientInfo]
    let unhandled: [Unhandled]
    let macros: Int
}

struct RouterStatus: Decodable {
    let id: String
    let name: String
    let inputs: Int
    let outputs: Int
    let clients: [ClientInfo]
}

struct EmulatorStatus: Decodable {
    let addresses: [String]
    let network: Bool
    let atem: SwitcherStatus?
    let videohub: RouterStatus?
    let bmdVideohubServer: Bool
    let port9990Busy: Bool?
    let dataDir: String?
}

struct LogChunk: Decodable { let lines: [String]; let next: Int }

struct APIError: Error { let message: String; let code: String? }

// MARK: - API client

enum API {
    static func get<T: Decodable>(_ path: String, as type: T.Type, timeout: TimeInterval = 1.5) -> T? {
        guard let url = URL(string: path, relativeTo: apiBase) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        var result: T?
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data { result = try? JSONDecoder().decode(T.self, from: data) }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + timeout + 0.5)
        return result
    }

    static func post(_ path: String, _ body: [String: Any] = [:], completion: @escaping (APIError?) -> Void) {
        var request = URLRequest(url: apiBase.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.timeoutInterval = 120 // pausing Videohub Server waits for a password
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: request) { data, response, error in
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                completion(ok ? nil : APIError(message: json["error"] as? String ?? error?.localizedDescription ?? "The emulator didn't respond.",
                                               code: json["code"] as? String))
            }
        }.resume()
    }
}

// MARK: - Shared state

final class EmulatorModel: ObservableObject {
    @Published var status: EmulatorStatus?
    @Published var atemModels: [AtemModelInfo] = []
    @Published var routerModels: [RouterModelInfo] = []
    @Published var log: [String] = []
    @Published var backendError: String?
    @Published var busy = false
    /// Set when starting a router failed because Blackmagic's Videohub Server holds port 9990.
    @Published var routerBlockedByBMDServer = false
    @Published var lastError: String?

    var onChange: (() -> Void)?
    private var logNext = 0

    var atemFamilies: [(String, [AtemModelInfo])] {
        var order: [String] = []
        var groups: [String: [AtemModelInfo]] = [:]
        for m in atemModels {
            if groups[m.family] == nil { order.append(m.family) }
            groups[m.family, default: []].append(m)
        }
        return order.map { ($0, groups[$0]!) }
    }

    func atemModel(_ id: String?) -> AtemModelInfo? { atemModels.first { $0.id == id } }
    func routerModel(_ id: String?) -> RouterModelInfo? { routerModels.first { $0.id == id } }

    // MARK: Refreshing

    /// Blocking refresh, for when the menu is about to open.
    func refreshNow() {
        let s = API.get("api/status", as: EmulatorStatus.self)
        apply(s)
    }

    func refresh(withLog: Bool = false) {
        DispatchQueue.global().async {
            let s = API.get("api/status", as: EmulatorStatus.self)
            let chunk = withLog ? API.get("api/log?after=\(self.logNext)", as: LogChunk.self) : nil
            DispatchQueue.main.async {
                self.apply(s)
                if let chunk {
                    // The emulator restarted (its line count went backwards): start the log over.
                    if chunk.next < self.logNext { self.log.removeAll() }
                    self.log.append(contentsOf: chunk.lines)
                    if self.log.count > 1000 { self.log.removeFirst(self.log.count - 1000) }
                    self.logNext = chunk.next
                }
            }
        }
    }

    private func apply(_ s: EmulatorStatus?) {
        status = s
        onChange?()
    }

    func loadModels() {
        guard let list = API.get("api/models", as: ModelList.self) else { return }
        atemModels = list.atem
        routerModels = list.videohub
        refresh(withLog: true)
    }

    // MARK: Actions

    private func run(_ path: String, _ body: [String: Any] = [:], onError: ((APIError) -> Void)? = nil) {
        busy = true
        lastError = nil
        API.post(path, body) { error in
            self.busy = false
            if let error {
                if let onError { onError(error) } else { self.lastError = error.message }
            }
            self.refresh(withLog: true)
        }
    }

    func startSwitcher(_ id: String) { run("api/atem/start", ["id": id]) }
    func stopSwitcher() { run("api/atem/stop") }
    func resetSwitcher() { run("api/atem/reset") }

    func startRouter(_ id: String, inputs: Int, outputs: Int) {
        routerBlockedByBMDServer = false
        run("api/videohub/start", ["id": id, "inputs": inputs, "outputs": outputs]) { error in
            if error.code == "BMD_SERVER" { self.routerBlockedByBMDServer = true }
            self.lastError = error.message
        }
    }
    func stopRouter() { run("api/videohub/stop") }
    func resetRouter() { run("api/videohub/reset") }

    /// Pauses (or resumes) Blackmagic's Videohub Server; macOS asks for a password.
    func setBMDServer(running: Bool, then: (() -> Void)? = nil) {
        run("api/bmd-videohub-server", ["action": running ? "start" : "stop"])
        if let then {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.whenIdle(then) }
        }
    }

    private func whenIdle(_ action: @escaping () -> Void) {
        if busy { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.whenIdle(action) } }
        else if lastError == nil { action() }
    }

    func setNetwork(_ on: Bool) { run("api/network", ["enabled": on]) }
}
