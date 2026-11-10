/*
 * Check one loopback connection against an owned Edge process tree.
 * Reads only process identity and socket metadata, never browser profile data.
 * The calling app must separately verify Edge's code signature. A denied or
 * incomplete OS query fails closed. stdout is only "1" or "0".
 */
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/proc_info.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <libproc.h>
#include <unistd.h>
#include <stdint.h>
#include <limits.h>
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#define MAX_PROCESSES 256
#define MAX_FDS 4096
#define MAX_DEPTH 16
static const char root_path[] = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
static const char child_prefix[] = "/Applications/Microsoft Edge.app/Contents/";
struct entry { int pid; int parent; unsigned depth; uint64_t sec; uint64_t usec; };

static int integer(const char *s, unsigned long long maximum, unsigned long long *result) {
    if (!s || !*s || strlen(s) > 20 || (s[0] == '0' && s[1])) return 0;
    for (const char *p = s; *p; p++) if (*p < '0' || *p > '9') return 0;
    char *end = NULL; errno = 0; unsigned long long n = strtoull(s, &end, 10);
    if (errno == ERANGE || !end || *end || n > maximum) return 0;
    *result = n; return 1;
}
static int info_for(int pid, struct proc_bsdinfo *info) {
    memset(info, 0, sizeof(*info));
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info)) == (int)sizeof(*info)
        && info->pbi_pid == (uint32_t)pid && info->pbi_uid == getuid()
        && info->pbi_start_tvsec > 0 && info->pbi_start_tvusec < 1000000;
}
static int process_path(int pid, int root) {
    char result[PROC_PIDPATHINFO_MAXSIZE]; memset(result, 0, sizeof(result));
    if (proc_pidpath(pid, result, sizeof(result)) <= 0 || !memchr(result, '\0', sizeof(result))) return 0;
    if (root) return strcmp(result, root_path) == 0;
    return strncmp(result, child_prefix, sizeof(child_prefix) - 1) == 0 && strstr(result, "/../") == NULL;
}
static int unchanged(const struct entry *entry) {
    struct proc_bsdinfo info;
    return info_for(entry->pid, &info) && info.pbi_ppid == (uint32_t)entry->parent
        && info.pbi_start_tvsec == entry->sec && info.pbi_start_tvusec == entry->usec
        && process_path(entry->pid, entry->depth == 0);
}
static int matches_socket(int pid, int fd, unsigned client_port, unsigned server_port) {
    struct socket_fdinfo sock; memset(&sock, 0, sizeof(sock));
    if (proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, &sock, sizeof(sock)) != (int)sizeof(sock)
        || sock.psi.soi_kind != SOCKINFO_TCP || sock.psi.soi_family != AF_INET
        || sock.psi.soi_type != SOCK_STREAM || sock.psi.soi_protocol != IPPROTO_TCP
        || sock.psi.soi_proto.pri_tcp.tcpsi_state != TSI_S_ESTABLISHED) return 0;
    const struct in_sockinfo *addr = &sock.psi.soi_proto.pri_tcp.tcpsi_ini;
    return (addr->insi_vflag & INI_IPV4) != 0 && ntohs((uint16_t)addr->insi_lport) == client_port
        && ntohs((uint16_t)addr->insi_fport) == server_port
        && addr->insi_laddr.ina_46.i46a_addr4.s_addr == htonl(INADDR_LOOPBACK)
        && addr->insi_faddr.ina_46.i46a_addr4.s_addr == htonl(INADDR_LOOPBACK);
}
static int verify(int root_pid, uint64_t sec, uint64_t usec, unsigned client_port, unsigned server_port) {
    struct proc_bsdinfo root;
    if (!info_for(root_pid, &root) || root.pbi_ppid != (uint32_t)getppid() || root.pbi_start_tvsec != sec
        || root.pbi_start_tvusec != usec || !process_path(root_pid, 1)) return 0;
    struct entry list[MAX_PROCESSES] = { { root_pid, (int)getppid(), 0, sec, usec } };
    int count = 1, matched_pid = -1, matched_fd = -1;
    for (int index = 0; index < count; index++) {
        struct entry current = list[index];
        if (!unchanged(&current)) return 0;
        struct proc_fdinfo fds[MAX_FDS];
        int size = proc_pidinfo(current.pid, PROC_PIDLISTFDS, 0, fds, sizeof(fds));
        if (size <= 0 || size >= (int)sizeof(fds) || size % (int)sizeof(fds[0])) return 0;
        for (int i = 0; i < size / (int)sizeof(fds[0]); i++) {
            if (fds[i].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
            if (matches_socket(current.pid, fds[i].proc_fd, client_port, server_port)) {
                if (matched_pid != -1) return 0;
                matched_pid = current.pid; matched_fd = fds[i].proc_fd;
            }
        }
        int children[MAX_PROCESSES]; int child_count = proc_listchildpids(current.pid, children, sizeof(children));
        if (child_count < 0 || child_count >= MAX_PROCESSES || (child_count && current.depth >= MAX_DEPTH)) return 0;
        for (int i = 0; i < child_count; i++) {
            int pid = children[i]; struct proc_bsdinfo info;
            if (pid <= 4 || count >= MAX_PROCESSES || !info_for(pid, &info) || info.pbi_ppid != (uint32_t)current.pid) return 0;
            for (int j = 0; j < count; j++) if (list[j].pid == pid) return 0;
            if (info.pbi_start_tvsec < current.sec || (info.pbi_start_tvsec == current.sec && info.pbi_start_tvusec < current.usec)) return 0;
            list[count++] = (struct entry){ pid, current.pid, current.depth + 1, info.pbi_start_tvsec, info.pbi_start_tvusec };
        }
    }
    if (matched_pid < 0 || !matches_socket(matched_pid, matched_fd, client_port, server_port)) return 0;
    for (int i = 0; i < count; i++) if (!unchanged(&list[i])) return 0;
    return 1;
}
int main(int argc, char **argv) {
    unsigned long long pid, sec, usec, client, server;
    if (argc != 6 || !integer(argv[1], INT_MAX, &pid) || pid <= 4 || !integer(argv[2], UINT64_MAX, &sec) || !sec
        || !integer(argv[3], 999999, &usec) || !integer(argv[4], 65535, &client) || !client
        || !integer(argv[5], 65535, &server) || !server || client == server) { (void)write(STDOUT_FILENO, "0", 1); return 2; }
    int ok = verify((int)pid, sec, usec, (unsigned)client, (unsigned)server);
    (void)write(STDOUT_FILENO, ok ? "1" : "0", 1); return ok ? 0 : 2;
}
