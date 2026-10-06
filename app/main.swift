// BMD Emulator: a menu bar app with a control window. Runs the emulator
// (emulator.mjs, with its own copy of Node) in the background and controls it
// through its local API.

import AppKit
import SwiftUI
import Combine
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    let model = EmulatorModel()
    private var statusItem: NSStatusItem!
    private var window: NSWindow?
    private var backend: Process?
    private var attached = false          // using an emulator someone started in Terminal
    private var timer: Timer?
    private var errorWatch: AnyCancellable?

    private let showWindowKey = "showWindowAtLaunch"
    private var showWindowAtLaunch: Bool {
        get { UserDefaults.standard.object(forKey: showWindowKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: showWindowKey) }
    }

    private lazy var dataDir: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BMD Emulator", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    // MARK: Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        model.onChange = { [weak self] in self?.updateIcon() }
        // Errors from menu actions appear as alerts; the window shows its own.
        errorWatch = model.$lastError.compactMap { $0 }.sink { [weak self] message in
            guard let self, self.window?.isVisible != true else { return }
            DispatchQueue.main.async { self.menuError(message) }
        }
        NSApp.mainMenu = makeMainMenu()
        updateIcon()
        startBackend()
        schedulePolling()
        if showWindowAtLaunch { showWindow() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        guard let p = backend, p.isRunning else { return }
        p.terminate() // the emulator saves and stops cleanly on SIGTERM
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { usleep(50_000) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    // MARK: Backend process

    private func startBackend() {
        if API.get("api/status", as: EmulatorStatus.self, timeout: 0.5) != nil {
            attached = true
            model.loadModels()
            return
        }
        guard let node = findNode(), let script = Bundle.main.url(forResource: "emulator", withExtension: "mjs", subdirectory: "emulator") else {
            model.backendError = "Couldn't find the emulator or Node.js inside the app."
            return
        }
        let p = Process()
        p.executableURL = node
        p.arguments = [script.path, "--no-browser", "--data", dataDir.path]
        p.currentDirectoryURL = script.deletingLastPathComponent()
        let logURL = dataDir.appendingPathComponent("emulator.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let log = try? FileHandle(forWritingTo: logURL) { p.standardOutput = log; p.standardError = log }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, self.backend === proc else { return }
                self.model.backendError = "The emulator stopped unexpectedly. Details are in emulator.log in the saved data folder."
                self.model.status = nil
                self.updateIcon()
            }
        }
        do {
            try p.run()
            backend = p
            model.backendError = nil
        } catch {
            model.backendError = "Couldn't start the emulator: \(error.localizedDescription)"
            return
        }
        DispatchQueue.global().async {
            for _ in 0..<50 {
                if API.get("api/status", as: EmulatorStatus.self, timeout: 0.3) != nil { break }
                usleep(200_000)
            }
            DispatchQueue.main.async { self.model.loadModels() }
        }
    }

    @objc func restartBackend() {
        model.backendError = nil
        attached = false
        if let p = backend, p.isRunning { backend = nil; p.terminate(); p.waitUntilExit() }
        backend = nil
        startBackend()
    }

    private func findNode() -> URL? {
        if let bundled = Bundle.main.url(forResource: "node", withExtension: nil, subdirectory: "bin") { return bundled }
        for path in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] where FileManager.default.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        return nil
    }

    // Faster updates (with the activity log) while the window is open.
    private func schedulePolling() {
        timer?.invalidate()
        let open = window?.isVisible == true
        timer = Timer.scheduledTimer(withTimeInterval: open ? 1 : 3, repeats: true) { [weak self] _ in
            self?.model.refresh(withLog: self?.window?.isVisible == true)
        }
    }

    // MARK: Window

    @objc func showWindow() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 700),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            w.title = "BMD Emulator"
            w.contentViewController = NSHostingController(rootView: ContentView().environmentObject(model))
            w.setFrameAutosaveName("BMD Emulator Window")
            w.isReleasedWhenClosed = false
            w.delegate = self
            if !w.setFrameUsingName("BMD Emulator Window") { w.center() }
            window = w
        }
        // A normal app (Dock icon, app menu) while the window is open.
        NSApp.setActivationPolicy(.regular)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        model.refresh(withLog: true)
        schedulePolling()
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // back to menu bar only
        DispatchQueue.main.async { self.schedulePolling() }
    }

    // The standard app menus, shown while the window is open (Quit, Copy/Paste, Close).
    private func makeMainMenu() -> NSMenu {
        let main = NSMenu()
        func submenu(_ title: String, _ items: [NSMenuItem]) {
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            holder.submenu = m
            main.addItem(holder)
        }
        func item(_ title: String, _ sel: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        submenu("BMD Emulator", [
            item("About BMD Emulator", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            .separator(),
            item("Hide BMD Emulator", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
            .separator(),
            item("Quit BMD Emulator", #selector(NSApplication.terminate(_:)), "q"),
        ])
        submenu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        submenu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Close", #selector(NSWindow.performClose(_:)), "w"),
        ])
        return main
    }

    // MARK: Menu bar icon

    private func updateIcon() {
        let s = model.status
        let running = s?.atem != nil || s?.videohub != nil
        let connected = !(s?.atem?.clients.isEmpty ?? true) || !(s?.videohub?.clients.isEmpty ?? true)
        let image = NSImage(systemSymbolName: connected ? "rectangle.split.3x1.fill" : "rectangle.split.3x1", accessibilityDescription: "BMD Emulator")
        image?.isTemplate = true
        statusItem.button?.image = image
        statusItem.button?.appearsDisabled = !running && model.backendError == nil
        statusItem.button?.toolTip = running ? "BMD Emulator — running" : "BMD Emulator"
    }

    // MARK: Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        model.refreshNow()
        menu.removeAllItems()
        menu.addItem(action("Open BMD Emulator…", #selector(showWindow), key: "o"))
        menu.addItem(.separator())

        if let failure = model.backendError {
            menu.addItem(info(failure))
            menu.addItem(action("Try Again", #selector(restartBackend)))
        } else if let s = model.status {
            addSwitcherSection(menu, s)
            menu.addItem(.separator())
            addRouterSection(menu, s)
            menu.addItem(.separator())
            let net = action("Allow Other Computers on the Network", #selector(toggleNetwork))
            net.state = s.network ? .on : .off
            menu.addItem(net)
        } else {
            menu.addItem(info("Starting…"))
        }
        if attached { menu.addItem(info("Using the emulator already running in Terminal")) }
        menu.addItem(.separator())
        let atLaunch = action("Open Window When App Starts", #selector(toggleShowWindow))
        atLaunch.state = showWindowAtLaunch ? .on : .off
        menu.addItem(atLaunch)
        let login = action("Start at Login", #selector(toggleLogin))
        if #available(macOS 13.0, *) { login.state = SMAppService.mainApp.status == .enabled ? .on : .off } else { login.isHidden = true }
        menu.addItem(login)
        menu.addItem(action("Show Saved Data in Finder", #selector(showData)))
        menu.addItem(.separator())
        menu.addItem(action("Quit BMD Emulator", #selector(quit), key: "q"))
    }

    private func addSwitcherSection(_ menu: NSMenu, _ s: EmulatorStatus) {
        menu.addItem(header("ATEM Switcher"))
        if let a = s.atem {
            menu.addItem(info("● \(a.name)"))
            let c = a.clients.compactMap(\.address)
            menu.addItem(info(c.isEmpty ? "   Waiting for ATEM Software Control" : "   Connected: \(c.joined(separator: ", "))"))
        } else {
            menu.addItem(info("Stopped"))
        }
        let models = NSMenuItem(title: s.atem == nil ? "Start Switcher" : "Switcher Model", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for (i, (family, list)) in model.atemFamilies.enumerated() {
            if i > 0 { sub.addItem(.separator()) }
            sub.addItem(header(family))
            for m in list {
                let item = action(m.name, #selector(startSwitcher(_:)))
                item.representedObject = m.id
                item.state = s.atem?.id == m.id ? .on : .off
                sub.addItem(item)
            }
        }
        models.submenu = sub
        menu.addItem(models)
        if s.atem != nil { menu.addItem(action("Stop Switcher", #selector(stopSwitcher))) }
    }

    private func addRouterSection(_ menu: NSMenu, _ s: EmulatorStatus) {
        menu.addItem(header("Videohub Router"))
        if let r = s.videohub {
            menu.addItem(info("● \(r.name) (\(r.inputs)×\(r.outputs))"))
            let c = r.clients.compactMap(\.address)
            menu.addItem(info(c.isEmpty ? "   Waiting for Videohub Control" : "   Connected: \(c.joined(separator: ", "))"))
        } else {
            menu.addItem(info("Stopped"))
        }
        let models = NSMenuItem(title: s.videohub == nil ? "Start Router" : "Router Model", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for m in model.routerModels {
            let item = action("\(m.name) (\(m.inputs)×\(m.outputs))", #selector(startRouter(_:)))
            item.representedObject = m.id
            item.state = s.videohub?.id == m.id ? .on : .off
            sub.addItem(item)
        }
        sub.addItem(.separator())
        sub.addItem(action("Custom Size…", #selector(showWindow)))
        models.submenu = sub
        menu.addItem(models)
        if s.videohub != nil { menu.addItem(action("Stop Router", #selector(stopRouter))) }
        if s.bmdVideohubServer && s.port9990Busy == true {
            menu.addItem(action("Pause Blackmagic Videohub Server…", #selector(pauseBMDServer)))
        }
    }

    private func header(_ title: String) -> NSMenuItem {
        if #available(macOS 14.0, *) { return NSMenuItem.sectionHeader(title: title) }
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.attributedTitle = NSAttributedString(string: title, attributes: [.font: NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)])
        item.isEnabled = false
        return item
    }

    private func info(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func action(_ title: String, _ selector: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        return item
    }

    // MARK: Menu actions

    @objc private func startSwitcher(_ sender: NSMenuItem) { model.startSwitcher(sender.representedObject as? String ?? "") }
    @objc private func stopSwitcher() { model.stopSwitcher() }

    @objc private func startRouter(_ sender: NSMenuItem) {
        guard let m = model.routerModel(sender.representedObject as? String) else { return }
        model.startRouter(m.id, inputs: m.inputs, outputs: m.outputs)
    }
    @objc private func stopRouter() { model.stopRouter() }
    @objc private func pauseBMDServer() { model.setBMDServer(running: false) }

    @objc private func toggleNetwork() {
        let on = model.status?.network ?? false
        if !on && !confirm("Allow other computers on the network?",
                           "Other computers will see the emulated switcher and router and can connect to them. Leave this off on a network with live equipment, so the emulators don't appear in other operators' software.", "Allow") { return }
        model.setNetwork(!on)
    }

    @objc private func toggleShowWindow() { showWindowAtLaunch.toggle() }

    @objc private func showData() {
        let dir = model.status?.dataDir.map { URL(fileURLWithPath: $0) } ?? dataDir
        NSWorkspace.shared.activateFileViewerSelecting([dir])
    }

    @objc private func toggleLogin() {
        guard #available(macOS 13.0, *) else { return }
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            menuError("Couldn't change Start at Login: \(error.localizedDescription)\n\nYou can also add BMD Emulator in System Settings → General → Login Items.")
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: Dialogs

    private func menuError(_ message: String) {
        if model.routerBlockedByBMDServer {
            if confirm("Port 9990 is in use", "Blackmagic's Videohub Server holds the port the emulated router needs. Open the window to pause it and start the router?", "Open Window") { showWindow() }
            return
        }
        let a = NSAlert()
        a.messageText = "BMD Emulator"
        a.informativeText = message
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }

    private func confirm(_ title: String, _ text: String, _ ok: String) -> Bool {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.addButton(withTitle: ok)
        a.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        return a.runModal() == .alertFirstButtonReturn
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // menu bar only until the window opens
app.run()
