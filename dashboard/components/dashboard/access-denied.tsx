import { ShieldAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function AccessDenied({ required = "Manage Channels / Manage Server / Administrator" }: { required?: string }) {
  return (
    <main className="mx-auto max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert size={18} />
            権限が不足しています
          </CardTitle>
          <CardDescription>Botが導入されていない、またはこのサーバーのDashboard閲覧権限がありません。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>必要権限: {required}</div>
          <div className="text-muted-foreground">管理者に、Bot導入状態とあなたのDiscord権限を確認してもらってください。</div>
        </CardContent>
      </Card>
    </main>
  );
}
