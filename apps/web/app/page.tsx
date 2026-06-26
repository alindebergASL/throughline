import Link from "next/link";

const navItems = ["Today", "Organizations", "Pulse"];

export default function Home() {
  return (
    <main className="shell">
      <header className="topbar">
        <strong>Throughline</strong>
        <label className="command">
          <span className="sr-only">Universal command and search</span>
          <input placeholder="Search or ask Throughline..." />
        </label>
      </header>
      <div className="layout">
        <nav aria-label="Primary">
          {navItems.map((item) => (
            <Link key={item} href={`#${item.toLowerCase()}`}>
              {item}
            </Link>
          ))}
        </nav>
        <section className="surface" aria-labelledby="page-title">
          <p className="eyebrow">Wave A1 shell</p>
          <h1 id="page-title">Throughline foundation</h1>
          <p>
            Minimal application shell only. Product screens, capture, review, truth ledger, and
            integrations are intentionally deferred to later approved waves.
          </p>
        </section>
      </div>
    </main>
  );
}
