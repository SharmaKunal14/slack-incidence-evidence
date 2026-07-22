import type { Metadata } from "next";
import { OnRecordSite } from "./site-experience";

export const metadata: Metadata = {
  title: "OnRecord — Put every incident on the record",
  description:
    "OnRecord turns fragmented Slack incident conversations into an evidence-linked postmortem your team can verify, revise, approve, and publish.",
};

export default function Home() {
  return <OnRecordSite />;
}
