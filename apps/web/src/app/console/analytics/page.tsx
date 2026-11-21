import { Suspense } from "react";
import { OverviewScreen } from "./_components/OverviewScreen";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <OverviewScreen />
    </Suspense>
  );
}
