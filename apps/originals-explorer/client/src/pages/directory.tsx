import { Link } from "wouter";
import { Folder, File, Plus, ArrowRightLeft, Image, Music, Video, DollarSign, Globe, ChevronDown, ChevronRight } from "lucide-react";
import { useState, useEffect } from "react";

interface Document {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
  layer: 'private' | 'public' | 'property';
}

export default function Directory() {
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    private: false,
    public: false,
    property: false,
  });
  const [documents, setDocuments] = useState<Document[]>([]);

  const toggleSection = (section: string) => {
    setCollapsedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  const getDocuments = (): Document[] => {
    const saved = localStorage.getItem("originals-documents");
    return saved ? JSON.parse(saved) : [];
  };

  useEffect(() => {
    // Load documents on component mount
    setDocuments(getDocuments());
    
    // Listen for storage changes to update documents list
    const handleStorageChange = () => {
      setDocuments(getDocuments());
    };
    
    window.addEventListener('storage', handleStorageChange);
    
    // Also listen for custom events when documents are saved from the same tab
    const handleDocumentUpdate = () => {
      setDocuments(getDocuments());
    };
    
    window.addEventListener('originals-documents-updated', handleDocumentUpdate);
    
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('originals-documents-updated', handleDocumentUpdate);
    };
  }, []);

  const handleDocumentClick = (docId: string) => {
    window.location.href = `/?doc=${docId}`;
  };

  return (
    <main className="max-w-6xl mx-auto px-8 py-16 pl-[6px] pr-[6px] pt-[6px] pb-[6px]">
      <div className="bg-white border border-gray-200 rounded-sm">
        {/* Tree structure */}
        <div className="tree-group">
          <div className="tree-folder" data-testid="private-folder" onClick={() => toggleSection('private')}>
            {collapsedSections.private ? 
              <ChevronRight className="w-3 h-3 mr-1 text-gray-400" /> : 
              <ChevronDown className="w-3 h-3 mr-1 text-gray-400" />
            }
            <Folder className="w-4 h-4 mr-3 text-blue-500" />
            <div className="flex-1">
              <div className="directory-text text-blue-700">Private</div>
              <div className="directory-description text-blue-600">Personal assets</div>
            </div>
          </div>

          {!collapsedSections.private && documents
            .filter(doc => (doc.layer || 'private') === 'private')
            .map((doc) => (
            <div 
              key={doc.id}
              className="tree-item cursor-pointer hover:bg-gray-50" 
              data-testid={`document-${doc.id}`}
              onClick={() => handleDocumentClick(doc.id)}
            >
              <File className="w-4 h-4 mr-3 text-gray-400" />
              <div>
                <div className="text-sm font-medium text-gray-700">{doc.title}</div>
                <div className="text-xs text-gray-500">
                  Updated {new Date(doc.updatedAt).toLocaleDateString()}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="tree-group">
          <div className="tree-folder" data-testid="public-folder" onClick={() => toggleSection('public')}>
            {collapsedSections.public ? 
              <ChevronRight className="w-3 h-3 mr-1 text-gray-400" /> : 
              <ChevronDown className="w-3 h-3 mr-1 text-gray-400" />
            }
            <Globe className="w-4 h-4 mr-3 text-green-500" />
            <div className="flex-1">
              <div className="directory-text text-green-700">Public</div>
              <div className="directory-description text-green-600">Shared assets</div>
            </div>
          </div>

          {!collapsedSections.public && documents
            .filter(doc => doc.layer === 'public')
            .map((doc) => (
            <div 
              key={doc.id}
              className="tree-item cursor-pointer hover:bg-gray-50" 
              data-testid={`document-${doc.id}`}
              onClick={() => handleDocumentClick(doc.id)}
            >
              <File className="w-4 h-4 mr-3 text-gray-400" />
              <div>
                <div className="text-sm font-medium text-gray-700">{doc.title}</div>
                <div className="text-xs text-gray-500">
                  Updated {new Date(doc.updatedAt).toLocaleDateString()}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="tree-group">
          <div className="tree-folder" data-testid="property-folder" onClick={() => toggleSection('property')}>
            {collapsedSections.property ? 
              <ChevronRight className="w-3 h-3 mr-1 text-gray-400" /> : 
              <ChevronDown className="w-3 h-3 mr-1 text-gray-400" />
            }
            <DollarSign className="w-4 h-4 mr-3 text-orange-500" />
            <div className="flex-1">
              <div className="directory-text text-orange-700">Property</div>
              <div className="directory-description text-orange-600">Tradable assets</div>
            </div>
          </div>

          {!collapsedSections.property && documents
            .filter(doc => doc.layer === 'property')
            .map((doc) => (
            <div 
              key={doc.id}
              className="tree-item cursor-pointer hover:bg-gray-50" 
              data-testid={`document-${doc.id}`}
              onClick={() => handleDocumentClick(doc.id)}
            >
              <File className="w-4 h-4 mr-3 text-gray-400" />
              <div>
                <div className="text-sm font-medium text-gray-700">{doc.title}</div>
                <div className="text-xs text-gray-500">
                  Updated {new Date(doc.updatedAt).toLocaleDateString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}