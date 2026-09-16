export const isLocalFeatureRequest = (request: Request) => {
  if (process.env.ALLOW_REMOTE_CURATION === "true") return true;
  if (process.env.NODE_ENV !== "development") return false;
  const hostname = new URL(request.url).hostname;
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
};
