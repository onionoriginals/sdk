import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Plus, GripVertical, Upload, User, MoreHorizontal } from "lucide-react";

interface Document {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
  layer: 'private' | 'public' | 'property';
}

interface Block {
  id: string;
  content: string;
  type: 'text';
}

export default function Homepage() {
  const [blocks, setBlocks] = useState<Block[]>([{ id: '1', content: '', type: 'text' }]);
  const [currentDocId, setCurrentDocId] = useState<string | null>(null);
  const [currentLayer, setCurrentLayer] = useState<'private' | 'public' | 'property'>('private');
  const [, setLocation] = useLocation();
  const [showBlockMenu, setShowBlockMenu] = useState<string | null>(null);
  const blockRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    // Check if we're loading a specific document from URL params
    const urlParams = new URLSearchParams(window.location.search);
    const docId = urlParams.get('doc');
    
    if (docId) {
      // Load specific document
      const documents = getDocuments();
      const document = documents.find(d => d.id === docId);
      if (document) {
        const contentBlocks = parseContentToBlocks(document.content);
        setBlocks(contentBlocks);
        setCurrentDocId(docId);
        setCurrentLayer(document.layer || 'private');
      }
    } else {
      // Load the current working document
      const savedText = localStorage.getItem("originals-current-document");
      if (savedText) {
        const contentBlocks = parseContentToBlocks(savedText);
        setBlocks(contentBlocks);
      }
    }
    
    // Focus the first block
    setTimeout(() => {
      const firstBlock = blockRefs.current['1'];
      if (firstBlock) {
        firstBlock.focus();
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

  const parseContentToBlocks = (content: string): Block[] => {
    if (!content.trim()) {
      return [{ id: '1', content: '', type: 'text' }];
    }
    
    const lines = content.split('\n');
    return lines.map((line, index) => ({
      id: (index + 1).toString(),
      content: line,
      type: 'text' as const
    }));
  };

  const blocksToContent = (blocks: Block[]): string => {
    return blocks.map(block => block.content).join('\n');
  };

  const generateTitle = (content: string): string => {
    const firstLine = content.split('\n')[0].trim();
    if (firstLine.length > 0) {
      return firstLine.length > 50 ? firstLine.substring(0, 47) + "..." : firstLine;
    }
    return `Document ${new Date().toLocaleDateString()}`;
  };

  const updateBlocks = (newBlocks: Block[]) => {
    setBlocks(newBlocks);
    
    const newContent = blocksToContent(newBlocks);
    
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

  const handleBlockChange = (blockId: string, content: string) => {
    const newBlocks = blocks.map(block => 
      block.id === blockId ? { ...block, content } : block
    );
    updateBlocks(newBlocks);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, blockId: string) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      createNewBlock(blockId);
    } else if (e.key === 'Backspace') {
      const block = blocks.find(b => b.id === blockId);
      if (block && block.content === '') {
        e.preventDefault();
        deleteBlock(blockId);
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      
      // Insert tab character at cursor position
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        
        // Insert tab character (or 4 spaces for better compatibility)
        const tabNode = document.createTextNode('\t');
        range.insertNode(tabNode);
        
        // Move cursor after the tab
        range.setStartAfter(tabNode);
        range.setEndAfter(tabNode);
        selection.removeAllRanges();
        selection.addRange(range);
        
        // Update the block content
        const target = e.target as HTMLDivElement;
        handleBlockChange(blockId, target.textContent || '');
      }
    }
  };

  const createNewBlock = (afterBlockId: string) => {
    const blockIndex = blocks.findIndex(b => b.id === afterBlockId);
    const newBlockId = Date.now().toString();
    const newBlock: Block = {
      id: newBlockId,
      content: '',
      type: 'text'
    };
    
    const newBlocks = [
      ...blocks.slice(0, blockIndex + 1),
      newBlock,
      ...blocks.slice(blockIndex + 1)
    ];
    
    setBlocks(newBlocks);
    
    // Focus the new block
    setTimeout(() => {
      const newBlockElement = blockRefs.current[newBlockId];
      if (newBlockElement) {
        newBlockElement.focus();
      }
    }, 10);
  };

  const deleteBlock = (blockId: string) => {
    if (blocks.length <= 1) return;
    
    const blockIndex = blocks.findIndex(b => b.id === blockId);
    const newBlocks = blocks.filter(b => b.id !== blockId);
    updateBlocks(newBlocks);
    
    // Focus the previous block
    const focusBlockIndex = Math.max(0, blockIndex - 1);
    const focusBlockId = newBlocks[focusBlockIndex]?.id;
    if (focusBlockId) {
      setTimeout(() => {
        const blockElement = blockRefs.current[focusBlockId];
        if (blockElement) {
          blockElement.focus();
          // Move cursor to end
          const range = document.createRange();
          const selection = window.getSelection();
          range.selectNodeContents(blockElement);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
      }, 10);
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
    setCurrentLayer('private');
    setCurrentDocId(null); // Clear current document ID
    // Dispatch event to update header
    window.dispatchEvent(new CustomEvent('originals-documents-updated'));
    window.location.href = "/";
  };

  return (
    <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 relative">
      <div 
        className="bg-white min-h-96 p-4 sm:p-6"
        onClick={(e) => {
          // Close block menu if clicking outside
          setShowBlockMenu(null);
          
          // Check if clicked on empty area (not on a block or button)
          const target = e.target as HTMLElement;
          if (target.classList.contains('bg-white') || target.classList.contains('p-4') || target.classList.contains('sm:p-6')) {
            // Create new block at the end
            const lastBlockId = blocks[blocks.length - 1]?.id;
            if (lastBlockId) {
              createNewBlock(lastBlockId);
            }
          }
        }}
      >
        {blocks.map((block, index) => (
          <div
            key={block.id}
            className="relative group"
          >
            <div
              ref={(el) => {
                blockRefs.current[block.id] = el;
                if (el && el.textContent !== block.content) {
                  el.textContent = block.content;
                }
              }}
              contentEditable
              suppressContentEditableWarning={true}
              className={`w-full py-2 px-3 -mx-3 text-gray-900 leading-relaxed text-base font-normal outline-none resize-none transition-all duration-200 ${
                index === 0 && block.content === '' ? 'empty-first-block' : ''
              }`}
              data-testid={`block-${block.id}`}
              onInput={(e) => {
                const target = e.target as HTMLDivElement;
                handleBlockChange(block.id, target.textContent || '');
              }}
              onKeyDown={(e) => handleKeyDown(e, block.id)}
              onClick={(e) => e.stopPropagation()} // Prevent triggering parent click
              style={{
                minHeight: '2rem',
              }}
            />
            
            {/* Block controls - Notion style */}
            <div className="absolute left-[-52px] top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-10">
              <div className="flex items-center space-x-1">
                {/* Add block button */}
                <button
                  className="w-6 h-6 bg-white hover:bg-gray-100 rounded flex items-center justify-center transition-all duration-150"
                  onClick={(e) => {
                    e.stopPropagation();
                    createNewBlock(block.id);
                  }}
                  data-testid={`add-block-${block.id}`}
                  title="Add block"
                >
                  <Plus className="w-4 h-4 text-gray-500 hover:text-gray-700" />
                </button>
                
                {/* Grip handle (6-dot) */}
                <button
                  className="w-6 h-6 bg-white hover:bg-gray-100 rounded flex items-center justify-center transition-all duration-150 cursor-grab active:cursor-grabbing"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowBlockMenu(showBlockMenu === block.id ? null : block.id);
                  }}
                  data-testid={`grip-block-${block.id}`}
                  title="Click for options"
                >
                  <GripVertical className="w-4 h-4 text-gray-400 hover:text-gray-600" />
                </button>
              </div>
            </div>
            
            {/* Block Menu Popup */}
            {showBlockMenu === block.id && (
              <div className="absolute left-[-12px] top-8 w-64 bg-gray-800 text-white rounded-lg shadow-xl z-50 py-2">
                <div className="px-3 py-2 border-b border-gray-700">
                  <input 
                    type="text" 
                    placeholder="Search actions..." 
                    className="w-full bg-gray-700 text-white text-sm px-3 py-1 rounded border border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-400"
                    autoFocus
                  />
                </div>
                
                <div className="py-1">
                  <div className="px-3 py-1 text-xs text-gray-400 uppercase tracking-wide">Text</div>
                  
                  <button 
                    className="w-full text-left px-3 py-2 hover:bg-gray-700 flex items-center justify-between text-sm"
                    onClick={() => {
                      // Duplicate block
                      const newBlock: Block = {
                        id: Date.now().toString(),
                        content: block.content,
                        type: 'text'
                      };
                      const blockIndex = blocks.findIndex(b => b.id === block.id);
                      const newBlocks = [...blocks];
                      newBlocks.splice(blockIndex + 1, 0, newBlock);
                      setBlocks(newBlocks);
                      setShowBlockMenu(null);
                    }}
                  >
                    <span className="flex items-center">
                      <span className="mr-2">📄</span>
                      Duplicate
                    </span>
                    <span className="text-gray-400 text-xs">⌘D</span>
                  </button>
                  
                  {blocks.length > 1 && (
                    <button 
                      className="w-full text-left px-3 py-2 hover:bg-gray-700 flex items-center justify-between text-sm text-red-400"
                      onClick={() => {
                        deleteBlock(block.id);
                        setShowBlockMenu(null);
                      }}
                    >
                      <span className="flex items-center">
                        <span className="mr-2">🗑️</span>
                        Delete
                      </span>
                      <span className="text-gray-500 text-xs">Del</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
        
        {/* Clickable area below blocks */}
        <div 
          className="min-h-20 w-full"
          onClick={(e) => {
            e.stopPropagation();
            const lastBlockId = blocks[blocks.length - 1]?.id;
            if (lastBlockId) {
              createNewBlock(lastBlockId);
            }
          }}
          data-testid="click-area-below-blocks"
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