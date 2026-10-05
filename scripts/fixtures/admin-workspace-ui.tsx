import React from "react";
import { createRoot } from "react-dom/client";
import { AdminConsole } from "../../dashboard/components/admin/admin-console";
import "../../dashboard/app/globals.css";

createRoot(document.getElementById("root")!).render(<React.StrictMode><div className="bg-muted px-4 py-2 text-center text-xs">ローカル操作検証 / 架空の記録 / 本番API・Discordへの通信なし</div><AdminConsole user={{ id: "222222222222222222", username: "管理者", isAdmin: true }} /></React.StrictMode>);
