import type { Metadata } from "next";
import { OnRecordSite } from "./site-experience";

export const metadata: Metadata = {
  title: "OnRecord — Put every incident on the record",
  description:
    "Turn messy Slack incident conversations into an evidence-linked record reviewed and approved by a human.",
};

export default function Home() {
  return <OnRecordSite />;
}
