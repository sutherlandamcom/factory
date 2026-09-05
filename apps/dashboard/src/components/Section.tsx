import type { ReactNode } from "react";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 border-b border-gray-100 pb-2 text-lg font-semibold text-gray-800">
        {title}
      </h2>
      {children}
    </section>
  );
}
