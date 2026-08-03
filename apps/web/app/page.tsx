import Link from "next/link";

const navItems = ["Today", "Organizations", "Pulse"];

export default function Home() {
  return (
    <div className="shell">
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
            <Link
              key={item}
              href={`#${item.toLowerCase()}`}
              aria-current={item === "Today" ? "page" : undefined}
            >
              {item}
            </Link>
          ))}
        </nav>
        <main className="surface" aria-labelledby="page-title">
          <p className="eyebrow">Organizations</p>
          <h1 id="page-title">Trusted objective demo</h1>
          <p>Open the deterministic Initiative after running the bounded local demo setup.</p>
          <Link
            className="primary-link"
            href="/organizations/initiatives/70000000-0000-7000-8000-000000000204"
          >
            Open Initiative
          </Link>
        </main>
      </div>
    </div>
  );
}
