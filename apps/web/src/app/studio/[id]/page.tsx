import { ListingEditor } from "../../_components/studio/ListingEditor";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ListingEditor productId={id} />;
}
