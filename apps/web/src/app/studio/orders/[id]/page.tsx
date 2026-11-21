import { StudioOrderDetail } from "../../../_components/studio/StudioOrderDetail";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StudioOrderDetail orderId={id} />;
}
