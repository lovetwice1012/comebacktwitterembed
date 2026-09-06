package main

import (
	"context"
	"errors"
	"strings"
)

const ociWorkloadUnit = "cbte-recovery-workload.service"

func serviceProfile(cfg Config) string {
	if cfg.ServiceControlProfile != "" {
		return cfg.ServiceControlProfile
	}
	if cfg.RecoveryNode == "oci" || cfg.BotUnit == ociWorkloadUnit {
		return "oci-guarded"
	}
	return "systemd"
}

func validateServiceProfile(cfg Config) error {
	profile := serviceProfile(cfg)
	if profile != "systemd" && profile != "oci-guarded" {
		return errors.New("ADMIN_AGENT_SERVICE_PROFILE must be systemd or oci-guarded")
	}
	if profile == "oci-guarded" && cfg.BotUnit != ociWorkloadUnit {
		return errors.New("OCI service controls require the fixed cbte-recovery-workload.service guardian unit")
	}
	if profile == "systemd" && (cfg.RecoveryNode == "oci" || cfg.BotUnit == ociWorkloadUnit) {
		return errors.New("OCI guardian workloads cannot use the primary systemd service profile")
	}
	return nil
}

func serviceActionUnavailable(cfg Config, typ string, input Object) string {
	if serviceProfile(cfg) != "oci-guarded" {
		return ""
	}
	switch typ {
	case "analysis.status", "analysis.restart":
		return "OCIの分析・レポートworkerは起動許可付き稼働グループの子プロセスで、独立したsystemdサービスではありません。状態は技術診断で確認し、必要なら影響を確認してBot稼働グループを再起動してください。"
	case "database.status", "database.restart":
		return "OCIのMySQLは復元候補に紐づくDockerコンテナで、mysql.serviceではありません。DB診断で疎通を確認できますが、この画面からDB単独の停止・再起動はできません。"
	case "logs.previous_boot":
		switch str(input["source"]) {
		case "database", "analysis", "reports":
			return "OCIではDB・分析・レポートに個別systemd unitの前回起動ログはありません。Botの起動許可監視ログ、管理コア、kernelのログを選択してください。"
		}
	}
	return ""
}

func privilegedActionUnit(cfg Config, typ string) (string, string) {
	unit, verb := cfg.BotUnit, strings.TrimPrefix(typ, "service.")
	for prefix, target := range map[string]string{"agent.": "cbte-admin.service", "database.": "mysql.service", "analysis.": "cbte-admin-analysis.service"} {
		if strings.HasPrefix(typ, prefix) {
			return target, strings.TrimPrefix(typ, prefix)
		}
	}
	return unit, verb
}

func serviceControls(cfg Config) Object {
	value := Object{"profile": serviceProfile(cfg), "botUnit": cfg.BotUnit, "executorConfigured": cfg.ExecutorSocket != "", "independentCoreUnit": "cbte-admin.service"}
	if serviceProfile(cfg) == "oci-guarded" {
		value["description"] = "OCIのBot操作は起動許可監視unitを通して行います。起動許可がない場合は待機し、Bot・通常Web・分析/レポートworkerを直接起動しません。停止・再起動はこれらの稼働グループ全体に影響します。独立管理コアは継続します。"
		value["limitations"] = []string{
			"分析・レポートworkerの個別systemd操作は未対応です。技術診断とBot稼働グループの操作を利用してください。",
			"MySQLコンテナの単独再起動は未対応です。DB診断で疎通を確認できます。",
			"Botログは起動許可監視unitのjournalです。個別workerのファイルログは含みません。",
		}
	} else {
		value["description"] = "Bot・管理コア・分析worker・MySQLの固定systemdサービスを操作します。"
		value["limitations"] = []string{}
	}
	return value
}

func catalogForConfig(cfg Config) []Object {
	items := make([]Object, 0, len(catalog()))
	for _, item := range catalog() {
		description := item.Description
		if serviceProfile(cfg) == "oci-guarded" {
			switch item.Type {
			case "service.status":
				description = "OCIの起動許可監視unitの状態・起動ID。Bot接続完了は稼働画面の証拠で別途確認します。"
			case "service.start":
				description = "OCIの起動許可監視unitを起動します。起動許可がなければ待機し、Botが接続済みであることは意味しません。"
			case "service.stop":
				description = "停止指示を復旧コントローラーへ保存してから、Bot・通常Web・分析/レポートworkerを含むOCI稼働グループを停止します。"
			case "service.restart":
				description = "停止・保守指示を尊重し、確認した起動IDのOCI稼働グループ全体を再起動します。分析/レポートの実行中処理にも影響します。"
			case "logs.read":
				description = "OCI起動許可監視unitのjournal。個別workerのファイルログやMySQLコンテナログは含みません。"
			}
		}
		reason := serviceActionUnavailable(cfg, item.Type, item.InputExample)
		items = append(items, Object{"type": item.Type, "label": item.Label, "description": description, "inputExample": item.InputExample, "mutating": item.Mutating, "available": reason == "", "unavailableReason": reason})
	}
	return items
}

func (a *App) monitorAnalysis(ctx context.Context, snapshot Object, policy Policy, maintenance bool, eventID string) {
	if maintenance && serviceProfile(a.cfg) == "oci-guarded" {
		a.failures["analysis.unavailable"] = 0
		return // Standby children are intentionally absent; this is not an incident.
	}
	analysis := nested(snapshot, "analysisHTTP")
	if analysis["configured"] != true {
		return
	}
	if analysis["ok"] == false {
		a.bad("analysis.unavailable")
		if a.failures["analysis.unavailable"] < 3 {
			return
		}
		reason := serviceActionUnavailable(a.cfg, "analysis.restart", Object{})
		workerUnit := Object{"available": false, "state": "not_applicable", "reason": reason}
		nextActions := []string{"diagnostics.collect", "service.status"}
		if reason == "" {
			workerUnit = unitSnapshot(ctx, "cbte-admin-analysis.service")
			nextActions = []string{"analysis.status", "analysis.restart"}
		}
		a.detect("analysis.unavailable", "分析workerが応答していません", Object{"eventIds": []string{eventID}, "http": analysis, "unit": workerUnit, "nextActions": nextActions}, policy)
		if reason == "" && policy.AutoRestartAnalysis && !maintenance && str(workerUnit["InvocationID"]) != "" && (str(workerUnit["ActiveState"]) == "failed" || str(workerUnit["ActiveState"]) == "inactive") {
			_, _, _ = a.store.enqueue("analysis.restart", Object{"expectedInvocationId": str(workerUnit["InvocationID"]), "reason": "Independent worker failed three health probes and systemd reports failed/inactive"}, "analysis-repair:"+str(workerUnit["InvocationID"]), a.cfg.Owner, "automation")
		}
	} else if analysis["ok"] == true {
		a.good("analysis.unavailable", Object{"eventIds": []string{eventID}, "scope": "Analysis HTTP recovered; provider or database operations require their own checks"})
	}
}
