"use client";

import { ResultsView } from "../../components/ResultsView";

/** A client's view of their Results, without the console around it. */
export function ClientReport({ token }: { token: string }) {
  return (
    <main className="client-report">
      <ResultsView endpoint={`/api/r/${token}`} operator={false} />
      <footer className="client-report-credit">Report by Eumon</footer>
    </main>
  );
}
