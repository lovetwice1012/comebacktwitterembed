#ifndef FIXTURE_PROC_INFO_H
#define FIXTURE_PROC_INFO_H
#include <stdint.h>
#include <sys/types.h>
#include <netinet/in.h>
#define PROC_PIDTBSDINFO 3
#define PROC_PIDLISTFDS 1
#define PROC_PIDFDSOCKETINFO 3
#define PROX_FDTYPE_SOCKET 2
#define SOCKINFO_TCP 2
#define TSI_S_ESTABLISHED 4
#define INI_IPV4 1
struct proc_bsdinfo { uint32_t pbi_pid; uint32_t pbi_ppid; uid_t pbi_uid; uint64_t pbi_start_tvsec; uint64_t pbi_start_tvusec; };
struct proc_fdinfo { int32_t proc_fd; uint32_t proc_fdtype; };
struct in4in6_addr { uint32_t pad[3]; struct in_addr i46a_addr4; };
struct in_sockinfo { int insi_fport, insi_lport; uint8_t insi_vflag; union { struct in4in6_addr ina_46; } insi_faddr, insi_laddr; };
struct tcp_sockinfo { struct in_sockinfo tcpsi_ini; int tcpsi_state; };
struct socket_info { int soi_type, soi_protocol, soi_family, soi_kind; union { struct tcp_sockinfo pri_tcp; } soi_proto; };
struct socket_fdinfo { struct socket_info psi; };
#endif
