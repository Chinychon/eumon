import { ClientReport } from "./ClientReport";

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ClientReport token={token} />;
}
