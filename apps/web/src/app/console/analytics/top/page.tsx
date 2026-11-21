import { Suspense } from "react";
import { TopScreen } from "../_components/TopScreen";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <TopScreen />
    </Suspense>
  );
}
