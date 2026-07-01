import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "comebacktwitterembed Dashboard",
  description: "Guild settings dashboard for comebacktwitterembed",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
