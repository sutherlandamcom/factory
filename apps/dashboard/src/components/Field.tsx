import type { ReactNode } from "react";

interface FieldProps {
  label: string;
  value?: string | number | undefined | null;
  error?: string;
  children?: ReactNode;
  htmlFor?: string;
}

/**
 * Dual-mode field: with `children` it renders a labeled form control
 * wrapper (React Hook Form bindings); without children it renders a
 * read-only label/value row.
 */
export function Field({ label, value, error, children, htmlFor }: FieldProps) {
  if (children) {
    return (
      <div>
        {htmlFor ? (
          <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-gray-700">
            {label}
          </label>
        ) : (
          <span className="mb-1 block text-sm font-medium text-gray-700">{label}</span>
        )}
        {children}
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    );
  }
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-1 whitespace-pre-line text-sm text-gray-800">{value || "—"}</dd>
    </div>
  );
}
