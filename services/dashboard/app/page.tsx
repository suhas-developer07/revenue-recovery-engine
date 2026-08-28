export default function DashboardPage() {
  return (
    <div>
      <h1>Revenue Recovery Dashboard</h1>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1.5rem", marginTop: "2rem" }}>
        <div style={{ padding: "1.5rem", border: "1px solid #ddd", borderRadius: "8px" }}>
          <h3>Total at-risk ₹</h3>
          <p style={{ fontSize: "2rem", fontWeight: "bold" }}>₹—</p>
        </div>
        <div style={{ padding: "1.5rem", border: "1px solid #ddd", borderRadius: "8px" }}>
          <h3>Recovered ₹</h3>
          <p style={{ fontSize: "2rem", fontWeight: "bold", color: "green" }}>₹—</p>
        </div>
        <div style={{ padding: "1.5rem", border: "1px solid #ddd", borderRadius: "8px" }}>
          <h3>Recovery Rate</h3>
          <p style={{ fontSize: "2rem", fontWeight: "bold" }}>—%</p>
        </div>
      </div>
      <p style={{ marginTop: "2rem", color: "#666" }}>TODO: Wire to Postgres, populate with batch data in Phase 6.</p>
    </div>
  );
}
