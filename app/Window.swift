// The BMD Emulator window: pick, start and watch the emulated switcher and router.

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var model: EmulatorModel
    @State private var confirmNetwork = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if let error = model.backendError {
                Banner(text: error, color: .red)
            } else if model.status == nil {
                Banner(text: "Starting the emulator…", color: .secondary)
            }
            HStack(alignment: .top, spacing: 14) {
                SwitcherPanel()
                RouterPanel()
            }
            if let error = model.lastError, !model.routerBlockedByBMDServer {
                Banner(text: error, color: .red)
            }
            ActivityPanel()
        }
        .padding(18)
        .frame(minWidth: 860, minHeight: 640)
        .disabled(model.status == nil)
        .alert("Allow other computers on the network?", isPresented: $confirmNetwork) {
            Button("Allow") { model.setNetwork(true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Other computers will see the emulated switcher and router and can connect to them. Leave this off on a network with live equipment, so the emulators don't appear in other operators' software.")
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("BMD Emulator").font(.title2.bold())
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Toggle("Allow other computers on the network", isOn: Binding(
                    get: { model.status?.network ?? false },
                    set: { on in if on { confirmNetwork = true } else { model.setNetwork(false) } }))
                Text(networkNote).font(.caption).foregroundColor(.secondary)
            }
        }
    }

    private var networkNote: String {
        guard let s = model.status else { return "" }
        if !s.network { return "Visible to software on this Mac only." }
        return s.addresses.isEmpty ? "Visible on the network." : "Visible on the network at \(s.addresses.joined(separator: ", "))."
    }
}

// MARK: - Switcher

struct SwitcherPanel: View {
    @EnvironmentObject var model: EmulatorModel
    @State private var selection = ""
    @State private var confirmReset = false

    private var running: SwitcherStatus? { model.status?.atem }

    var body: some View {
        Panel(title: "ATEM Switcher", symbol: "rectangle.split.3x1", on: running != nil) {
            Picker("Model", selection: $selection) {
                ForEach(model.atemFamilies, id: \.0) { family, models in
                    Section(header: Text(family)) {
                        ForEach(models) { m in Text(m.name).tag(m.id) }
                    }
                }
            }
            .labelsHidden()
            sourceNote
            HStack {
                Button(running == nil ? "Start" : (running?.id == selection ? "Restart" : "Switch to This Model")) { model.startSwitcher(selection) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(selection.isEmpty || model.busy)
                Button("Stop") { model.stopSwitcher() }.disabled(running == nil || model.busy)
                Spacer()
                Button("Reset to Factory…") { confirmReset = true }.disabled(running == nil || model.busy)
            }
            StatusBox {
                if let s = running {
                    Text("Running: ").bold() + Text(s.name)
                    Text(s.clients.isEmpty ? "Waiting for ATEM Software Control" : "Connected: \(s.clients.compactMap(\.address).joined(separator: ", "))")
                        .foregroundColor(s.clients.isEmpty ? .secondary : .primary)
                    Text("\(s.macros) macro\(s.macros == 1 ? "" : "s") stored").foregroundColor(.secondary)
                    Text("In ATEM Software Control choose “\(s.name) (Emulator)” or connect to 127.0.0.1.")
                        .font(.callout).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                    if !s.unhandled.isEmpty {
                        DisclosureGroup("\(s.unhandled.count) kind\(s.unhandled.count == 1 ? "" : "s") of change not stored yet") {
                            Text("These settings were sent by the software but aren't kept yet, so they won't be in a saved file: " +
                                 s.unhandled.map { "\($0.name) ×\($0.count)" }.joined(separator: ", "))
                                .font(.callout).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                } else {
                    Text("Stopped.").foregroundColor(.secondary)
                }
            }
        }
        .onAppear(perform: syncSelection)
        .onChange(of: running?.id) { _ in syncSelection() }
        .onChange(of: model.atemModels.count) { _ in syncSelection() }
        .alert("Reset the emulated switcher?", isPresented: $confirmReset) {
            Button("Reset", role: .destructive) { model.resetSwitcher() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This erases everything programmed into it: macros, labels and settings.")
        }
    }

    @ViewBuilder private var sourceNote: some View {
        if model.atemModel(selection)?.source == "captured" {
            Text("Using the state captured from your own switcher.").font(.callout).foregroundColor(.secondary)
        }
    }

    private func syncSelection() {
        if let id = running?.id { selection = id }
        else if selection.isEmpty, let first = model.atemModels.first { selection = first.id }
    }
}

// MARK: - Router

struct RouterPanel: View {
    @EnvironmentObject var model: EmulatorModel
    @State private var selection = ""
    @State private var inputs = 40
    @State private var outputs = 40
    @State private var confirmReset = false

    private var running: RouterStatus? { model.status?.videohub }

    var body: some View {
        Panel(title: "Videohub Router", symbol: "square.grid.3x3", on: running != nil) {
            Picker("Model", selection: $selection) {
                ForEach(model.routerModels) { m in Text("\(m.name) (\(m.inputs)×\(m.outputs))").tag(m.id) }
                Divider()
                Text("Custom size").tag("custom")
            }
            .labelsHidden()
            .onChange(of: selection) { id in
                if let m = model.routerModel(id) { inputs = m.inputs; outputs = m.outputs }
            }
            HStack {
                Text("Inputs")
                TextField("Inputs", value: $inputs, formatter: NumberFormatter()).frame(width: 60)
                Text("Outputs").padding(.leading, 8)
                TextField("Outputs", value: $outputs, formatter: NumberFormatter()).frame(width: 60)
                Spacer()
            }
            .disabled(selection != "custom")
            HStack {
                Button(running == nil ? "Start" : "Restart with This Model") { start() }
                    .disabled(selection.isEmpty || model.busy)
                Button("Stop") { model.stopRouter() }.disabled(running == nil || model.busy)
                Spacer()
                Button("Reset…") { confirmReset = true }.disabled(running == nil || model.busy)
            }
            if model.routerBlockedByBMDServer {
                Banner(text: "Port 9990 is in use by Blackmagic's Videohub Server.", color: .orange) {
                    Button("Pause It and Start") { model.setBMDServer(running: false) { start() } }
                }
            }
            StatusBox {
                if let r = running {
                    Text("Running: ").bold() + Text("\(r.name) (\(r.inputs)×\(r.outputs))")
                    Text(r.clients.isEmpty ? "Waiting for Videohub Control" : "Connected: \(r.clients.compactMap(\.address).joined(separator: ", "))")
                        .foregroundColor(r.clients.isEmpty ? .secondary : .primary)
                    Text("Videohub Control lists it as “\(r.name.replacingOccurrences(of: "Blackmagic ", with: "")) (Emulator)”.")
                        .font(.callout).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("Stopped.").foregroundColor(.secondary)
                }
            }
            if model.status?.bmdVideohubServer == true {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Blackmagic Videohub Server").font(.callout.bold())
                    Text(model.status?.port9990Busy == true
                         ? "Running, and holding port 9990, which the emulated router needs. Pausing asks for your Mac password; it comes back after a restart."
                         : "Not in the way right now.")
                        .font(.callout).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("Pause It") { model.setBMDServer(running: false) }
                            .disabled(model.status?.port9990Busy != true || model.busy)
                        Button("Resume It") { model.setBMDServer(running: true) }
                            .disabled(model.status?.port9990Busy == true || running != nil || model.busy)
                    }
                }
            }
        }
        .onAppear(perform: syncSelection)
        .onChange(of: running?.id) { _ in syncSelection() }
        .onChange(of: model.routerModels.count) { _ in syncSelection() }
        .alert("Reset the emulated router?", isPresented: $confirmReset) {
            Button("Reset", role: .destructive) { model.resetRouter() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Labels and routing go back to their defaults.")
        }
    }

    private func start() {
        model.startRouter(selection, inputs: max(1, min(288, inputs)), outputs: max(1, min(288, outputs)))
    }

    private func syncSelection() {
        if let r = running {
            selection = model.routerModel(r.id) != nil ? r.id : "custom"
            inputs = r.inputs
            outputs = r.outputs
        } else if selection.isEmpty, let first = model.routerModels.first {
            selection = first.id
            inputs = first.inputs
            outputs = first.outputs
        }
    }
}

// MARK: - Activity

struct ActivityPanel: View {
    @EnvironmentObject var model: EmulatorModel

    var body: some View {
        GroupBox(label: Text("Activity").font(.headline)) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(model.log.enumerated()), id: \.offset) { i, line in
                            Text(line).font(.system(.caption, design: .monospaced)).textSelection(.enabled).id(i)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
                }
                .onChange(of: model.log.count) { n in if n > 0 { proxy.scrollTo(n - 1, anchor: .bottom) } }
            }
            .frame(minHeight: 150)
        }
    }
}

// MARK: - Building blocks

struct Panel<Content: View>: View {
    let title: String
    let symbol: String
    let on: Bool
    @ViewBuilder let content: Content

    var body: some View {
        GroupBox(label: HStack(spacing: 6) {
            Circle().fill(on ? Color.green : Color.secondary.opacity(0.5)).frame(width: 8, height: 8)
            Label(title, systemImage: symbol).font(.headline)
        }) {
            VStack(alignment: .leading, spacing: 10) { content }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .top)
    }
}

struct StatusBox<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 4) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
    }
}

struct Banner<Accessory: View>: View {
    let text: String
    let color: Color
    @ViewBuilder var accessory: Accessory

    var body: some View {
        HStack {
            Text(text).foregroundColor(color == .secondary ? .secondary : .primary).fixedSize(horizontal: false, vertical: true)
            Spacer()
            accessory
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(color.opacity(0.12)))
    }
}

extension Banner where Accessory == EmptyView {
    init(text: String, color: Color) { self.init(text: text, color: color) { EmptyView() } }
}
