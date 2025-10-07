import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Plus, User } from "lucide-react";

interface Document {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
  layer: 'private' | 'public' | 'property';
}

export default function Homepage() {
  const [content, setContent] = useState<string>('');
  const [currentDocId, setCurrentDocId] = useState<string | null>(null);
  const [currentLayer, setCurrentLayer] = useState<'private' | 'public' | 'property'>('private');
  const [, setLocation] = useLocation();
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // Check if we're loading a specific document from URL params
    const urlParams = new URLSearchParams(window.location.search);
    const docId = urlParams.get('doc');
    
    if (docId) {
      // Load specific document
      const documents = getDocuments();
      const document = documents.find(d => d.id === docId);
      if (document) {
        setContent(document.content);
        setCurrentDocId(docId);
        setCurrentLayer(document.layer || 'private');
      }
    } else {
      // Load the current working document
      const savedText = localStorage.getItem("originals-current-document");
      if (savedText) {
        setContent(savedText);
      }
    }
    
    // Focus the text area
    setTimeout(() => {
      if (textAreaRef.current) {
        textAreaRef.current.focus();
      }
    }, 100);
  }, []);

  // Separate useEffect for publish event listener to avoid re-registration
  useEffect(() => {
    const handlePublishEvent = (event: any) => {
      handlePublish();
    };
    
    window.addEventListener('publish-document', handlePublishEvent);
    
    return () => {
      window.removeEventListener('publish-document', handlePublishEvent);
    };
  }, [currentDocId, currentLayer]); // Dependencies needed for handlePublish to work correctly

  const getDocuments = (): Document[] => {
    const saved = localStorage.getItem("originals-documents");
    return saved ? JSON.parse(saved) : [];
  };

  const saveDocuments = (documents: Document[]) => {
    localStorage.setItem("originals-documents", JSON.stringify(documents));
  };

  const generateTitle = (content: string): string => {
    const firstLine = content.split('\n')[0].trim();
    if (firstLine.length > 0) {
      return firstLine.length > 50 ? firstLine.substring(0, 47) + "..." : firstLine;
    }
    return `Document ${new Date().toLocaleDateString()}`;
  };

  const updateContent = (newContent: string) => {
    setContent(newContent);
    
    // Save current working document
    localStorage.setItem("originals-current-document", newContent);
    
    // Auto-save document when it has content
    if (newContent.trim().length > 0) {
      const documents = getDocuments();
      const title = generateTitle(newContent);
      const now = new Date().toISOString();
      
      if (currentDocId) {
        // Update existing document
        const docIndex = documents.findIndex(d => d.id === currentDocId);
        if (docIndex !== -1) {
          documents[docIndex] = {
            ...documents[docIndex],
            title,
            content: newContent,
            updatedAt: now,
            layer: documents[docIndex].layer || 'private'
          };
        }
      } else {
        // Create new document
        const newDocId = Date.now().toString();
        const newDoc: Document = {
          id: newDocId,
          title,
          content: newContent,
          updatedAt: now,
          layer: currentLayer
        };
        documents.push(newDoc);
        setCurrentDocId(newDocId);
        
        // Update URL to include document ID
        window.history.replaceState({}, '', `/?doc=${newDocId}`);
      }
      
      saveDocuments(documents);
      
      // Dispatch custom event for same-tab updates
      window.dispatchEvent(new CustomEvent('originals-documents-updated'));
    } else {
      // If document becomes empty and it was a saved document, remove it
      if (currentDocId) {
        const documents = getDocuments();
        const filteredDocs = documents.filter(d => d.id !== currentDocId);
        saveDocuments(filteredDocs);
        
        // Dispatch custom event for same-tab updates
        window.dispatchEvent(new CustomEvent('originals-documents-updated'));
        setCurrentDocId(null);
        window.history.replaceState({}, '', '/');
      }
    }
  };

  const handleContentChange = (newContent: string) => {
    updateContent(newContent);
  };

  const handleTextAreaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle Tab for indentation
    if (e.key === 'Tab') {
      e.preventDefault();
      
      const target = e.target as HTMLTextAreaElement;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const value = target.value;
      
      // Insert tab at cursor position
      const newValue = value.substring(0, start) + '\t' + value.substring(end);
      
      // Update the content
      handleContentChange(newValue);
      
      // Set cursor position after the tab
      setTimeout(() => {
        target.setSelectionRange(start + 1, start + 1);
      }, 0);
    }
  };

  const handlePublish = () => {
    if (currentLayer === 'private' && currentDocId) {
      // Migrate document to public layer
      const documents = getDocuments();
      const docIndex = documents.findIndex(d => d.id === currentDocId);
      if (docIndex !== -1) {
        documents[docIndex] = {
          ...documents[docIndex],
          layer: 'public',
          updatedAt: new Date().toISOString()
        };
        saveDocuments(documents);
        setCurrentLayer('public');
        
        // Dispatch custom event for same-tab updates
        window.dispatchEvent(new CustomEvent('originals-documents-updated'));
      }
    }
  };

  const handleNewDocument = () => {
    localStorage.removeItem("originals-document");
    localStorage.removeItem("originals-current-document");
    localStorage.removeItem("last-viewed-doc-id"); // Clear last viewed document
    setContent(''); // Clear content
    setCurrentLayer('private');
    setCurrentDocId(null); // Clear current document ID
    // Dispatch event to update header
    window.dispatchEvent(new CustomEvent('originals-documents-updated'));
    window.history.replaceState({}, '', '/');
  };

  return (
    <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 relative">
      <div className="bg-white min-h-96 p-4 sm:p-6">
        <textarea
          ref={textAreaRef}
          value={content}
          onChange={(e) => handleContentChange(e.target.value)}
          onKeyDown={handleTextAreaKeyDown}
          className="w-full h-96 py-2 px-3 text-gray-900 leading-relaxed text-base font-normal outline-none border-none resize-none bg-transparent"
          placeholder="Start writing..."
          data-testid="main-text-area"
          style={{
            fontFamily: 'inherit'
          }}
        />
      </div>
      
      {/* Floating Action Buttons */}
      <div className="fixed bottom-8 right-8 flex flex-col items-end space-y-3 group/fab">
        {/* User Profile Button - Behind with fancy animation */}
        {localStorage.getItem('dev-auth') === 'true' && (
          <button
            className="w-10 h-10 bg-blue-600 hover:bg-blue-700 text-white rounded-full flex items-center justify-center transition-all duration-500 transform translate-y-14 opacity-0 group-hover/fab:translate-y-0 group-hover/fab:opacity-100 shadow-lg hover:shadow-xl"
            data-testid="profile-button"
            onClick={() => {
              // Profile functionality here
              console.log('Profile clicked');
            }}
          >
            <User className="w-4 h-4" />
          </button>
        )}
        
        {/* New Document Button */}
        <button
          onClick={handleNewDocument}
          className="w-12 h-12 bg-gray-900 hover:bg-gray-700 text-white rounded-full flex items-center justify-center transition-all duration-300 shadow-lg hover:shadow-xl group/new z-10"
          data-testid="new-button"
        >
          <Plus className="w-5 h-5 transition-transform duration-300 group-hover/new:rotate-90" />
          <span className="absolute -top-10 right-1/2 translate-x-1/2 bg-gray-900 text-white text-xs px-2 py-1 rounded opacity-0 group-hover/new:opacity-100 transition-opacity duration-300 whitespace-nowrap">
            New
          </span>
        </button>
      </div>
    </main>
  );
}