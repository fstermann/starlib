import { notFound } from "next/navigation";

import { DesignShowcase } from "./design-showcase";

export default function DesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DesignShowcase />;
}
