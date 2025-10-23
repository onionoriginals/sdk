import { useLocation } from "wouter";

export default function Homepage() {
  const [, navigate] = useLocation();

  return (
    <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 relative">
      <div className="bg-white min-h-96 p-4 sm:p-6 flex flex-col items-center justify-center">
        <div className="text-center max-w-2xl">
          <h1 className="text-3xl font-light text-gray-900 mb-4">
            Welcome to Originals
          </h1>
          <p className="text-gray-600 mb-8 leading-relaxed">
            Create, discover, and manage digital assets with cryptographically verifiable provenance.
            Your assets are organized across three layers: private creation (did:peer), public discovery (did:webvh),
            and transferable ownership (did:btco).
          </p>
          <button
            onClick={() => navigate('/create')}
            className="px-6 py-3 bg-gray-900 hover:bg-gray-700 text-white rounded-md transition-colors"
          >
            Create Your First Asset
          </button>
        </div>
      </div>
    </main>
  );
}