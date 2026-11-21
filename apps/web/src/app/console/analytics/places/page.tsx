import { Suspense } from "react";
import { PlacesScreen } from "../_components/PlacesScreen";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PlacesScreen />
    </Suspense>
  );
}
