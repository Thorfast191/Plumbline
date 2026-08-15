import type { ReactNode } from "react";

export const metadata = {
  title: "Plumbline",
  description: "Reporting layer on top of Shopify.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
