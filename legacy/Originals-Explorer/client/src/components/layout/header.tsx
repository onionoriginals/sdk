import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { WalletConnector } from "@/components/wallet/wallet-connector";
import { useAuth } from "@/hooks/useAuth";
import { Menu, X, FolderTree, FileText, Upload, LogOut, User as UserIcon } from "lucide-react";

interface Document {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
  layer: 'private' | 'public' | 'property';
}

export default function Header() {
  const [location] = useLocation();
  const [currentDocument, setCurrentDocument] = useState<Document | null>(null);
  const [lastViewedDocId, setLastViewedDocId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { isAuthenticated, user, logout } = useAuth();

  const getDocuments = (): Document[] => {
    const saved = localStorage.getItem("originals-documents");
    return saved ? JSON.parse(saved) : [];
  };

  useEffect(() => {
    const updateCurrentDocument = () => {
      const urlParams = new URLSearchParams(window.location.search);
      const docId = urlParams.get('doc');
      
      if (docId) {
        const documents = getDocuments();
        const document = documents.find(d => d.id === docId);
        setCurrentDocument(document || null);
        setLastViewedDocId(docId);
        // Store last viewed document
        localStorage.setItem('last-viewed-doc-id', docId);
      } else {
        // When no doc ID in URL, try to use last viewed document
        const savedLastDocId = localStorage.getItem('last-viewed-doc-id');
        if (savedLastDocId) {
          const documents = getDocuments();
          const lastDocument = documents.find(d => d.id === savedLastDocId);
          setCurrentDocument(lastDocument || null);
          setLastViewedDocId(savedLastDocId);
        } else {
          setCurrentDocument(null);
          setLastViewedDocId(null);
        }
      }
    };

    // Update on mount
    updateCurrentDocument();

    // Listen for URL changes
    window.addEventListener('popstate', updateCurrentDocument);
    
    // Listen for document updates
    window.addEventListener('originals-documents-updated', updateCurrentDocument);
    
    return () => {
      window.removeEventListener('popstate', updateCurrentDocument);
      window.removeEventListener('originals-documents-updated', updateCurrentDocument);
    };
  }, [location]);

  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
        <div className="flex justify-between items-center">
          {/* Left Section - Logo + Document Info */}
          <div className="flex items-center space-x-2 sm:space-x-4 min-w-0 flex-1">
            <button 
              onClick={() => {
                window.location.href = "/";
              }}
              className="text-gray-900 font-light text-lg sm:text-xl tracking-tight hover:text-gray-700 transition-colors shrink-0" 
              data-testid="logo-button"
            >
              Originals
            </button>
            
            {/* Document Info - Responsive layout */}
            {currentDocument && location === "/" && (
              <div className="flex items-center space-x-2 sm:space-x-3 pl-2 sm:pl-4 border-l border-gray-200 min-w-0 flex-1">
                <div className="min-w-0 flex-1">
                  {/* Mobile: Single line with title + layer dot */}
                  <div className="sm:hidden flex items-center space-x-2 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate flex-1" data-testid="mobile-document-title" title={currentDocument.title}>
                      {currentDocument.title}
                    </div>
                    <div 
                      className={`w-3 h-3 rounded-full shrink-0 ${
                        (currentDocument.layer || 'private') === 'private' 
                          ? 'bg-blue-600' 
                          : (currentDocument.layer || 'private') === 'public'
                          ? 'bg-green-600'
                          : 'bg-orange-600'
                      }`} 
                      data-testid="mobile-document-type"
                      title={`${(currentDocument.layer || 'private') === 'private' ? 'Private' : (currentDocument.layer || 'private') === 'public' ? 'Public' : 'Property'} layer`}
                    />
                  </div>
                  
                  {/* Desktop: Two line layout */}
                  <div className="hidden sm:block">
                    <div className="text-sm font-medium text-gray-900 truncate max-w-[150px] lg:max-w-[200px]" data-testid="document-title" title={currentDocument.title}>
                      {currentDocument.title}
                    </div>
                    <div 
                      className={`text-xs font-medium ${
                        (currentDocument.layer || 'private') === 'private' 
                          ? 'text-blue-600' 
                          : (currentDocument.layer || 'private') === 'public'
                          ? 'text-green-600'
                          : 'text-orange-600'
                      }`} 
                      data-testid="document-type"
                    >
                      {(currentDocument.layer || 'private') === 'private' && 'Private'}
                      {(currentDocument.layer || 'private') === 'public' && 'Public'}
                      {(currentDocument.layer || 'private') === 'property' && 'Property'}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
          
          {/* Right Section - Desktop Navigation */}
          <div className="hidden md:flex items-center space-x-4 lg:space-x-6">
            {location === "/dir" ? (
              <Link href="/">
                <button className="flex items-center text-gray-600 hover:text-gray-900 transition-colors" data-testid="button-document">
                  <FileText className="w-4 h-4 mr-2" />
                  <span className="hidden lg:inline">{currentDocument ? currentDocument.title : 'Document'}</span>
                  <span className="lg:hidden">Doc</span>
                </button>
              </Link>
            ) : (
              <Link href="/dir">
                <button className="flex items-center text-gray-600 hover:text-gray-900 transition-colors" data-testid="button-directory">
                  <FolderTree className="w-4 h-4 mr-2" />
                  <span className="hidden lg:inline">Directory</span>
                  <span className="lg:hidden">Dir</span>
                </button>
              </Link>
            )}
            
            {/* Publish Button - Desktop */}
            {currentDocument && location === "/" && (currentDocument.layer || 'private') === 'private' && isAuthenticated && (
              <button
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('publish-document', { detail: { docId: currentDocument.id } }));
                }}
                className="bg-green-600 hover:bg-green-700 text-white px-3 lg:px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 flex items-center gap-1 lg:gap-2"
                data-testid="header-publish-button"
              >
                <Upload className="w-4 h-4" />
                <span className="hidden lg:inline">Publish</span>
              </button>
            )}
            
            {/* Authentication */}
            {isAuthenticated ? (
              <Link href="/profile">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 hover:bg-gray-100 rounded-full transition-colors cursor-pointer" data-testid="profile-button">
                  <div className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs font-medium">
                    {user?.email ? user.email.charAt(0).toUpperCase() : <UserIcon className="w-3 h-3" />}
                  </div>
                  <span className="text-sm font-medium text-gray-700 hidden sm:inline">
                    {user?.email ? user.email.split('@')[0] : 'User'}
                  </span>
                </div>
              </Link>
            ) : (
              <Link href={`/login?returnTo=${encodeURIComponent(window.location.pathname)}`}>
                <Button variant="outline" size="sm" data-testid="login-button">
                  Sign In
                </Button>
              </Link>
            )}
          </div>
          
          {/* Mobile Menu Button */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden p-2 text-gray-600 hover:text-gray-900 transition-colors"
            data-testid="mobile-menu-button"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
        
        {/* Mobile Menu */}
        {mobileMenuOpen && (
          <div className="md:hidden mt-4 pt-4 border-t border-gray-200">
            <div className="flex flex-col space-y-4">
              {/* Document Layer Info - Mobile Only */}
              {currentDocument && location === "/" && (
                <div className="bg-gray-50 px-3 py-2 rounded-lg">
                  <div className="text-xs text-gray-500 mb-1">Current Document</div>
                  <div className="flex items-center space-x-2">
                    <div 
                      className={`w-2.5 h-2.5 rounded-full ${
                        (currentDocument.layer || 'private') === 'private' 
                          ? 'bg-blue-600' 
                          : (currentDocument.layer || 'private') === 'public'
                          ? 'bg-green-600'
                          : 'bg-orange-600'
                      }`}
                    />
                    <span 
                      className={`text-sm font-medium ${
                        (currentDocument.layer || 'private') === 'private' 
                          ? 'text-blue-600' 
                          : (currentDocument.layer || 'private') === 'public'
                          ? 'text-green-600'
                          : 'text-orange-600'
                      }`}
                    >
                      {(currentDocument.layer || 'private') === 'private' && 'Private Layer'}
                      {(currentDocument.layer || 'private') === 'public' && 'Public Layer'}
                      {(currentDocument.layer || 'private') === 'property' && 'Property Layer'}
                    </span>
                  </div>
                </div>
              )}
              
              {/* Navigation - Mobile */}
              <div className="flex flex-col space-y-3">
                {location === "/dir" ? (
                  <Link href="/">
                    <button 
                      className="flex items-center text-gray-600 hover:text-gray-900 transition-colors w-full" 
                      data-testid="mobile-button-document"
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      <FileText className="w-4 h-4 mr-3" />
                      {currentDocument ? currentDocument.title : 'Document'}
                    </button>
                  </Link>
                ) : (
                  <Link href="/dir">
                    <button 
                      className="flex items-center text-gray-600 hover:text-gray-900 transition-colors w-full" 
                      data-testid="mobile-button-directory"
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      <FolderTree className="w-4 h-4 mr-3" />
                      Directory
                    </button>
                  </Link>
                )}
                
                {/* Publish Button - Mobile */}
                {currentDocument && location === "/" && (currentDocument.layer || 'private') === 'private' && isAuthenticated && (
                  <button
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent('publish-document', { detail: { docId: currentDocument.id } }));
                      setMobileMenuOpen(false);
                    }}
                    className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 flex items-center gap-2 w-full justify-center"
                    data-testid="mobile-publish-button"
                  >
                    <Upload className="w-4 h-4" />
                    Publish
                  </button>
                )}
              </div>
              
              {/* Authentication - Mobile */}
              <div className="pt-3 border-t border-gray-100">
                {isAuthenticated ? (
                  <Link href="/profile">
                    <div 
                      className="flex items-center gap-3 p-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors cursor-pointer"
                      data-testid="mobile-profile-button"
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-medium">
                        {user?.email ? user.email.charAt(0).toUpperCase() : <UserIcon className="w-4 h-4" />}
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-medium text-gray-900">
                          {user?.email ? user.email.split('@')[0] : 'User'}
                        </div>
                        <div className="text-xs text-gray-500">View profile</div>
                      </div>
                    </div>
                  </Link>
                ) : (
                  <Link href={`/login?returnTo=${encodeURIComponent(window.location.pathname)}`}>
                    <Button 
                      variant="outline" 
                      className="w-full" 
                      data-testid="mobile-login-button"
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      Sign In
                    </Button>
                  </Link>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
