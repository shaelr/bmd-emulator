// Connects to an ATEM (or the emulator) through Blackmagic's own Switchers SDK, the
// code ATEM Software Control uses, and reports OK or the exact failure reason.
// Built and run by tools/sdk-check.mjs; pass a second argument to list input names.
#include "BMDSwitcherAPI.h"
#include <CoreFoundation/CoreFoundation.h>
#include <cstdio>
int main(int argc, char** argv) {
    const char* ip = argc > 1 ? argv[1] : "127.0.0.1";
    IBMDSwitcherDiscovery* discovery = CreateBMDSwitcherDiscoveryInstance();
    if (!discovery) { printf("SDK not available\n"); return 2; }
    IBMDSwitcher* switcher = nullptr;
    BMDSwitcherConnectToFailure fail = (BMDSwitcherConnectToFailure)0;
    CFStringRef addr = CFStringCreateWithCString(kCFAllocatorDefault, ip, kCFStringEncodingUTF8);
    HRESULT hr = discovery->ConnectTo(addr, &switcher, &fail);
    CFRelease(addr);
    if (hr != S_OK) {
        const char* why = fail == bmdSwitcherConnectToFailureNoResponse ? "no response"
            : fail == bmdSwitcherConnectToFailureIncompatibleFirmware ? "incompatible firmware"
            : fail == bmdSwitcherConnectToFailureCorruptData ? "corrupt data"
            : fail == bmdSwitcherConnectToFailureStateSync ? "state sync failed"
            : fail == bmdSwitcherConnectToFailureStateSyncTimedOut ? "state sync timed out" : "unknown";
        printf("FAIL: %s\n", why);
        return 1;
    }
    CFStringRef name = nullptr;
    switcher->GetProductName(&name);
    char buf[256] = "?";
    if (name) { CFStringGetCString(name, buf, sizeof buf, kCFStringEncodingUTF8); CFRelease(name); }
    printf("OK: %s\n", buf);
    if (argc > 2) {   // also list every input name exactly as the SDK sees it
        IBMDSwitcherInputIterator* it = nullptr;
        if (switcher->CreateIterator(IID_IBMDSwitcherInputIterator, (void**)&it) == S_OK) {
            IBMDSwitcherInput* in = nullptr;
            while (it->Next(&in) == S_OK) {
                BMDSwitcherInputId id = 0; in->GetInputId(&id);
                CFStringRef l = nullptr, sh = nullptr; in->GetLongName(&l); in->GetShortName(&sh);
                char lb[64] = "", sb[16] = "";
                if (l) { CFStringGetCString(l, lb, sizeof lb, kCFStringEncodingUTF8); CFRelease(l); }
                if (sh) { CFStringGetCString(sh, sb, sizeof sb, kCFStringEncodingUTF8); CFRelease(sh); }
                printf("  %lld:%s/%s\n", (long long)id, lb, sb);
                in->Release();
            }
            it->Release();
        }
    }
    switcher->Release();
    discovery->Release();
    return 0;
}
