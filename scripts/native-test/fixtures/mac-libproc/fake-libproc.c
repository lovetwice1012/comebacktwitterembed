#include <sys/proc_info.h>
#include <libproc.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <arpa/inet.h>

int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize) {
    (void)arg;
    const char *mode = getenv("MAC_IDENTITY_TEST_CASE");
    if (mode && !strcmp(mode, "missing")) return 0;
    if (flavor == PROC_PIDLISTFDS) {
        if (mode && !strcmp(mode, "fd-error")) return 0;
        if (buffersize < (int)sizeof(struct proc_fdinfo)) return 0;
        struct proc_fdinfo *fd = buffer; fd->proc_fd = 7; fd->proc_fdtype = pid == 456 ? PROX_FDTYPE_SOCKET : 0;
        if (pid == 456 && mode && !strcmp(mode, "duplicate")) {
            if (buffersize < (int)(2 * sizeof(*fd))) return 0;
            fd[1].proc_fd = 8; fd[1].proc_fdtype = PROX_FDTYPE_SOCKET; return (int)(2 * sizeof(*fd));
        }
        return (int)sizeof(*fd);
    }
    if (buffersize != (int)sizeof(struct proc_bsdinfo)) return 0;
    struct proc_bsdinfo *info = buffer;
    info->pbi_pid = (uint32_t)pid; info->pbi_ppid = pid == 456 ? 123 : (uint32_t)getppid(); info->pbi_uid = getuid();
    info->pbi_start_tvsec = pid == 456 ? 1700000001 : 1700000000; info->pbi_start_tvusec = 123456;
    static int child_checks = 0;
    if (pid == 456 && mode && !strcmp(mode, "reused") && ++child_checks > 1) info->pbi_start_tvsec++;
    if (mode && !strcmp(mode, "pid")) info->pbi_pid++;
    if (mode && !strcmp(mode, "parent")) info->pbi_ppid++;
    if (mode && !strcmp(mode, "user")) info->pbi_uid++;
    if (mode && !strcmp(mode, "seconds")) info->pbi_start_tvsec = 0;
    if (mode && !strcmp(mode, "microseconds")) info->pbi_start_tvusec = 1000000;
    return (int)sizeof(*info);
}
int proc_pidpath(int pid, void *buffer, uint32_t buffersize) {
    const char *mode = getenv("MAC_IDENTITY_TEST_CASE");
    const char *value = mode && (!strcmp(mode, "path") || (!strcmp(mode, "child-path") && pid == 456)) ? "/tmp/untrusted" : pid == 456
        ? "/Applications/Microsoft Edge.app/Contents/Frameworks/Edge Helper" : "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    if (strlen(value) + 1 > buffersize) return 0;
    memcpy(buffer, value, strlen(value) + 1); return (int)strlen(value);
}
int proc_listchildpids(pid_t ppid, void *buffer, int buffersize) {
    const char *mode = getenv("MAC_IDENTITY_TEST_CASE");
    if (mode && !strcmp(mode, "child-error")) return -1;
    if (ppid != 123) return 0;
    if (buffersize < (int)sizeof(int)) return -1;
    ((int *)buffer)[0] = 456; return 1;
}
int proc_pidfdinfo(int pid, int fd, int flavor, void *buffer, int buffersize) {
    (void)fd; (void)flavor;
    if (pid != 456 || buffersize != (int)sizeof(struct socket_fdinfo)) return 0;
    const char *mode = getenv("MAC_IDENTITY_TEST_CASE");
    struct socket_fdinfo *sock = buffer;
    sock->psi.soi_kind = SOCKINFO_TCP; sock->psi.soi_family = AF_INET; sock->psi.soi_type = SOCK_STREAM; sock->psi.soi_protocol = IPPROTO_TCP;
    sock->psi.soi_proto.pri_tcp.tcpsi_state = TSI_S_ESTABLISHED;
    struct in_sockinfo *addr = &sock->psi.soi_proto.pri_tcp.tcpsi_ini;
    addr->insi_vflag = INI_IPV4; addr->insi_lport = htons(30001); addr->insi_fport = htons(23457);
    addr->insi_laddr.ina_46.i46a_addr4.s_addr = htonl(INADDR_LOOPBACK); addr->insi_faddr.ina_46.i46a_addr4.s_addr = htonl(INADDR_LOOPBACK);
    if (mode && !strcmp(mode, "port")) addr->insi_lport = htons(30002);
    if (mode && !strcmp(mode, "address")) addr->insi_faddr.ina_46.i46a_addr4.s_addr = htonl(0x08080808);
    if (mode && !strcmp(mode, "closed")) sock->psi.soi_proto.pri_tcp.tcpsi_state = 0;
    return (int)sizeof(*sock);
}
