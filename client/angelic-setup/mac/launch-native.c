/*
 * Experimental macOS launcher. A release must sign this executable with the
 * hardened runtime and without the DYLD-environment exception; source code
 * alone cannot prevent a loader from acting before main().
 * Only paths alongside this executable are used. No browser data is read.
 */
#include <mach-o/dyld.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    static const char *const clear[] = {
        "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED",
        "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_V8_COVERAGE", "SSLKEYLOGFILE", "LD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
        "DYLD_FALLBACK_FRAMEWORK_PATH", "DYLD_VERSIONED_LIBRARY_PATH", "DYLD_VERSIONED_FRAMEWORK_PATH",
        "DYLD_ROOT_PATH", "DYLD_IMAGE_SUFFIX", NULL
    };
    char original[PATH_MAX], resolved[PATH_MAX], executable[PATH_MAX], script[PATH_MAX];
    uint32_t size = sizeof(original);
    if (_NSGetExecutablePath(original, &size) != 0 || !realpath(original, resolved)) return 2;
    char *last = strrchr(resolved, '/');
    if (!last || strcmp(last + 1, "Launch") != 0) return 2;
    *last = '\0';
    int a = snprintf(executable, sizeof(executable), "%s/MacNode", resolved);
    int b = snprintf(script, sizeof(script), "%s/MacSetup.cjs", resolved);
    if (a < 0 || b < 0 || (size_t)a >= sizeof(executable) || (size_t)b >= sizeof(script)) return 2;
    for (size_t i = 0; clear[i]; i++) if (unsetenv(clear[i]) != 0) return 2;
    execl(executable, executable, script, (char *)NULL);
    return 2;
}
