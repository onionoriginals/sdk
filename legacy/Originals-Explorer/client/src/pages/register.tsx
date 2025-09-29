import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function Register() {
  return (
    <main className="min-h-screen bg-white flex items-center justify-center px-4">
      <div className="max-w-md w-full space-y-8">
        <div className="bg-white shadow-sm border border-gray-200 rounded-sm p-8">
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-xl font-semibold text-gray-900">
                Register
              </h2>
              <p className="mt-2 text-sm text-gray-600">
                Registration is coming soon. For now, you can log in with any email address.
              </p>
            </div>

            <div className="space-y-4">
              <Link href="/login">
                <Button
                  className="w-full bg-gray-900 hover:bg-gray-800 text-white"
                  data-testid="login-link-button"
                >
                  Go to Login
                </Button>
              </Link>
            </div>
          </div>
        </div>

        <div className="text-center">
          <Link href="/" className="text-sm text-gray-600 hover:text-gray-900">
            ← Back to Home
          </Link>
        </div>
      </div>
    </main>
  );
}