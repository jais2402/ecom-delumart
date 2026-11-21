import { StudioOrderDetail } from "../../../_components/studio/StudioOrderDetail";

/** /studio/orders/{reference}: one order, named by its opaque per-seller reference (never an id). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StudioOrderDetail orderId={id} />;
}
