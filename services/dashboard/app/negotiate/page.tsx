import { Suspense } from "react";
import NegotiateClient from "./NegotiateClient";

export default function NegotiatePage() {
  return (
    <Suspense fallback={<div style={{ padding: "2rem", color: "#888" }}>Loading negotiation...</div>}>
      <NegotiateClient />
    </Suspense>
  );
}
