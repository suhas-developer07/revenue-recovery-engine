export const metadata = {
  title: "Revenue Recovery Dashboard",
  description: "AI-powered payment recovery system",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        <nav style={{ padding: "1rem 2rem", borderBottom: "1px solid #eee", display: "flex", gap: "2rem", alignItems: "center" }}>
          <strong>Revenue Recovery</strong>
          <a href="/">Dashboard</a>
          <a href="/feed">Live Feed</a>
          <a href="/audit">Audit Log</a>
          <a href="/promises">Promises</a>
          <a href="/negotiate">🎙️ Negotiate</a>
          <a href="/report">Report</a>
        </nav>
        <main style={{ padding: "2rem" }}>{children}</main>
      </body>
    </html>
  );
}
