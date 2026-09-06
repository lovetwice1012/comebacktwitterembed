package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/bcrypt"
)

var version = "1.0.0"

const timestampLayout = "2006-01-02T15:04:05.000000000Z"

type Config struct {
	Listen, StateDir, Token, PasswordHash, Owner, PublicURL, BasePath            string
	Node, Worker, WorkerDir, BotUnit, ExecutorSocket, WorkerURL, ReportWorkerURL string
	LocalHealthURL, PublicHealthURL, DiscordWebhook, PushWebhook                 string
	WorkerTimeout, MonitorInterval, ReportTimeout                                time.Duration
	CookieSecure                                                                 bool
	AllowedUserIDs                                                               []string
	DiscordClientID, DiscordClientSecret, DiscordRedirectURI                     string
	RecoveryControllerURL, RecoveryControllerToken                               string
	RecoveryIntentToken, RecoveryNode                                            string
}

func env(key, fallback string) string {
	if s := os.Getenv(key); s != "" {
		return s
	}
	return fallback
}
func envInt(key string, fallback int) int {
	n, e := strconv.Atoi(os.Getenv(key))
	if e != nil {
		return fallback
	}
	return n
}
func config() Config {
	return Config{
		Listen: env("ADMIN_AGENT_LISTEN", "127.0.0.1:30988"), StateDir: env("ADMIN_AGENT_STATE_DIR", "/var/lib/cbte-admin"),
		Token: os.Getenv("ADMIN_AGENT_TOKEN"), PasswordHash: os.Getenv("ADMIN_AGENT_PASSWORD_HASH"), Owner: env("ADMIN_OWNER_ID", "796972193287503913"), PublicURL: os.Getenv("ADMIN_AGENT_PUBLIC_URL"), BasePath: strings.TrimRight(os.Getenv("ADMIN_AGENT_BASE_PATH"), "/"),
		AllowedUserIDs:  strings.Split(env("ADMIN_ALLOWED_USER_IDS", "933314562487386122,796972193287503913"), ","),
		DiscordClientID: os.Getenv("ADMIN_DISCORD_CLIENT_ID"), DiscordClientSecret: os.Getenv("ADMIN_DISCORD_CLIENT_SECRET"), DiscordRedirectURI: os.Getenv("ADMIN_DISCORD_REDIRECT_URI"),
		RecoveryControllerURL: os.Getenv("RECOVERY_CONTROLLER_URL"), RecoveryControllerToken: os.Getenv("RECOVERY_CONTROLLER_TOKEN"),
		RecoveryIntentToken: os.Getenv("RECOVERY_INTENT_TOKEN"), RecoveryNode: os.Getenv("RECOVERY_NODE"),
		Node: env("ADMIN_AGENT_NODE", "/usr/bin/node"), Worker: os.Getenv("ADMIN_AGENT_WORKER"), WorkerDir: os.Getenv("ADMIN_AGENT_WORKER_DIR"), WorkerURL: os.Getenv("ADMIN_AGENT_WORKER_URL"), ReportWorkerURL: os.Getenv("ADMIN_AGENT_REPORT_WORKER_URL"),
		BotUnit: env("ADMIN_AGENT_BOT_UNIT", "cbte.service"), ExecutorSocket: env("ADMIN_AGENT_EXECUTOR_SOCKET", "/run/cbte-admin-executor/executor.sock"),
		LocalHealthURL: os.Getenv("ADMIN_AGENT_LOCAL_HEALTH_URL"), PublicHealthURL: os.Getenv("ADMIN_AGENT_PUBLIC_HEALTH_URL"),
		DiscordWebhook: os.Getenv("ADMIN_AGENT_DISCORD_WEBHOOK"), PushWebhook: os.Getenv("ADMIN_AGENT_PUSH_WEBHOOK"),
		WorkerTimeout:   time.Duration(max(5, min(600, envInt("ADMIN_AGENT_WORKER_TIMEOUT_SECONDS", 120)))) * time.Second,
		ReportTimeout:   time.Duration(max(30, min(3600, envInt("ADMIN_AGENT_REPORT_TIMEOUT_SECONDS", 660)))) * time.Second,
		MonitorInterval: time.Duration(max(5, envInt("ADMIN_AGENT_MONITOR_SECONDS", 15))) * time.Second,
		CookieSecure:    env("ADMIN_AGENT_COOKIE_SECURE", "true") != "false",
	}
}

func randomID() string {
	b := make([]byte, 24)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func now() string { return time.Now().UTC().Format(timestampLayout) }

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	if len(os.Args) > 1 && os.Args[1] == "password-hash" {
		line, e := bufio.NewReader(os.Stdin).ReadString('\n')
		if e != nil && len(line) == 0 {
			log.Fatal("read password from stdin")
		}
		line = strings.TrimRight(line, "\r\n")
		if len(line) < 14 {
			log.Fatal("password must be at least 14 characters")
		}
		h, e := bcrypt.GenerateFromPassword([]byte(line), 12)
		if e != nil {
			log.Fatal(e)
		}
		fmt.Println(string(h))
		return
	}
	cfg := config()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if len(os.Args) > 1 && os.Args[1] == "executor" {
		if e := serveExecutor(ctx, cfg); e != nil {
			log.Fatal(e)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "witness" {
		if e := runWitness(ctx, cfg); e != nil {
			log.Fatal(e)
		}
		return
	}
	if len(cfg.Token) < 32 {
		log.Fatal("ADMIN_AGENT_TOKEN must contain at least 32 characters")
	}
	if cfg.PasswordHash != "" {
		if _, e := bcrypt.Cost([]byte(cfg.PasswordHash)); e != nil {
			log.Fatal("invalid ADMIN_AGENT_PASSWORD_HASH")
		}
	}
	s, e := openStore(cfg.StateDir)
	if e != nil {
		log.Fatal(e)
	}
	defer s.db.Close()
	a := newApp(cfg, s)
	if !a.allowedAdmin(cfg.Owner) {
		log.Fatal("ADMIN_OWNER_ID must be present in ADMIN_ALLOWED_USER_IDS")
	}
	if e := a.ensureAuthStorage(); e != nil {
		log.Fatal(e)
	}
	if e := s.recoverActions(); e != nil {
		log.Fatal(e)
	}
	server := &http.Server{Addr: cfg.Listen, Handler: a.routes(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	listener, e := net.Listen("tcp", cfg.Listen)
	if e != nil {
		log.Fatal(e)
	}
	go a.work(ctx, false)
	go a.work(ctx, true)
	go a.monitor(ctx)
	go a.collectJournals(ctx)
	go a.deliverNotifications(ctx)
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	notifySystemd("READY=1\nSTATUS=Independent admin API ready")
	log.Printf("cbte-admin %s listening on %s", version, cfg.Listen)
	if e := server.Serve(listener); e != nil && !errors.Is(e, http.ErrServerClosed) {
		log.Fatal(e)
	}
}

func notifySystemd(message string) {
	path := os.Getenv("NOTIFY_SOCKET")
	if path == "" {
		return
	}
	if strings.HasPrefix(path, "@") {
		path = "\x00" + path[1:]
	}
	c, e := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: path, Net: "unixgram"})
	if e != nil {
		return
	}
	defer c.Close()
	_, _ = c.Write([]byte(message))
}
