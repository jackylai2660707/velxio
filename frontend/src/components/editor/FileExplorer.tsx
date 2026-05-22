import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import type { BoardKind } from '../../types/board';
import { BOARD_KIND_LABELS } from '../../types/board';
import { importProjectFile, PROJECT_FILE_ACCEPT } from '../../utils/importProject';
import './FileExplorer.css';

// SVG icons — same style as EditorToolbar (stroke-based, 16x16)
const IcoFile = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

const IcoHeader = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
);

const IcoNewFile = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="12" y1="18" x2="12" y2="12" />
    <line x1="9" y1="15" x2="15" y2="15" />
  </svg>
);

const IcoNewWorkspace = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <line x1="12" y1="11" x2="12" y2="17" />
    <line x1="9" y1="14" x2="15" y2="14" />
  </svg>
);

const IcoSave = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </svg>
);

const IcoOpen = () => (
  // Folder with an "open / upload arrow" — matches Save visually (both
  // are project-IO actions) but points the opposite way to signal load.
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <polyline points="12 11 12 17" />
    <polyline points="9 14 12 11 15 14" />
  </svg>
);

const IcoChevron = ({ open }: { open: boolean }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

// Board emoji icons — mirrors BoardPickerModal
const BOARD_ICON: Record<BoardKind, string> = {
  'arduino-uno': '⬤',
  'arduino-nano': '▪',
  'arduino-mega': '▬',
  'raspberry-pi-pico': '◆',
  'raspberry-pi-3': '⬛',
  esp32: '⬡',
  'esp32-s3': '⬡',
  'esp32-c3': '⬡',
};

// Color accent per board family
const BOARD_COLOR: Record<BoardKind, string> = {
  'arduino-uno': '#4fc3f7',
  'arduino-nano': '#4fc3f7',
  'arduino-mega': '#4fc3f7',
  'raspberry-pi-pico': '#ce93d8',
  'raspberry-pi-3': '#ef9a9a',
  esp32: '#a5d6a7',
  'esp32-s3': '#a5d6a7',
  'esp32-c3': '#a5d6a7',
};

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['h', 'hpp'].includes(ext)) return <IcoHeader />;
  return <IcoFile />;
}

interface ContextMenu {
  fileId: string;
  boardGroupId: string;
  x: number;
  y: number;
}

interface FileExplorerProps {
  onSaveClick: () => void;
  onNewClick: () => void;
}

export const FileExplorer: React.FC<FileExplorerProps> = ({ onSaveClick, onNewClick }) => {
  // Hidden <input type="file"> we trigger via ref when the user clicks
  // the Open project button.  Accepts both .vlx (Velxio native) and .zip
  // (Wokwi bundle); the dispatcher in utils/importProject.ts decides which
  // loader to run based on the file extension.  Kept outside React state so
  // the change event still fires when the user picks the same file twice.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handleOpenProjectClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);
  const handleProjectFilePicked = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the SAME file again later still fires onchange.
    e.target.value = '';
    if (!file) return;
    const friendlyName = file.name.toLowerCase().endsWith('.zip') ? 'Wokwi .zip' : '.vlx';
    if (
      !window.confirm(
        `Load this ${friendlyName} project? Your current workspace will be replaced. ` +
          `This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      const result = await importProjectFile(file);
      // .zip needs the caller to apply the payload to the stores (we keep
      // that asymmetry so the toolbar's import flow can also pop the
      // install-libraries modal afterwards). Here in the file explorer we
      // don't have that modal, so we apply the payload silently and just
      // warn in the console if the project references uninstalled libs.
      if (result.kind === 'zip') {
        const { loadFiles } = useEditorStore.getState();
        const { setComponents, setWires, setBoardType, setBoardPosition, stopSimulation } =
          useSimulatorStore.getState();
        stopSimulation();
        if (result.boardType) setBoardType(result.boardType);
        setBoardPosition(result.boardPosition);
        setComponents(result.components);
        setWires(result.wires);
        if (result.files.length > 0) loadFiles(result.files);
        if (result.libraries.length > 0) {
          console.warn(
            '[FileExplorer] Imported Wokwi zip references libraries you may need to install:',
            result.libraries,
          );
        }
      }
    } catch (err) {
      window.alert((err as Error).message);
    }
  }, []);

  const { t } = useTranslation();
  const {
    fileGroups,
    activeFileId,
    activeGroupId,
    openFile,
    createFile,
    deleteFile,
    renameFile,
    setActiveGroup,
  } = useEditorStore();
  const boards = useSimulatorStore((s) => s.boards);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const setActiveBoardId = useSimulatorStore((s) => s.setActiveBoardId);

  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Track which board group is creating a file: boardGroupId or null
  const [creatingInGroup, setCreatingInGroup] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState('');
  // Collapsed state per board ID
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const renameInputRef = useRef<HTMLInputElement>(null);
  const newFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (creatingInGroup && newFileInputRef.current) {
      newFileInputRef.current.focus();
    }
  }, [creatingInGroup]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu]);

  const switchToBoard = useCallback(
    (boardId: string, groupId: string) => {
      setActiveBoardId(boardId);
      // setActiveBoardId already calls setActiveGroup internally via the store
      // but we make sure the editor group is also in sync
      setActiveGroup(groupId);
    },
    [setActiveBoardId, setActiveGroup],
  );

  const handleFileClick = useCallback(
    (fileId: string, boardId: string, groupId: string) => {
      if (boardId !== activeBoardId) {
        switchToBoard(boardId, groupId);
      }
      openFile(fileId);
    },
    [activeBoardId, switchToBoard, openFile],
  );

  const handleContextMenu = (e: React.MouseEvent, fileId: string, boardGroupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ fileId, boardGroupId, x: e.clientX, y: e.clientY });
  };

  const startRename = (fileId: string, groupId: string) => {
    const files = fileGroups[groupId] ?? [];
    const file = files.find((f) => f.id === fileId);
    if (!file) return;
    setRenamingId(fileId);
    setRenameValue(file.name);
    setContextMenu(null);
  };

  const commitRename = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      renameFile(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  }, [renamingId, renameValue, renameFile]);

  const handleDelete = (fileId: string, groupId: string) => {
    setContextMenu(null);
    const files = fileGroups[groupId] ?? [];
    if (files.length <= 1) return;
    if (!window.confirm(t('editor.fileExplorer.confirmDelete'))) return;
    deleteFile(fileId);
  };

  const startCreateFile = (boardId: string, groupId: string) => {
    // Switch to this board first so createFile targets the right group
    switchToBoard(boardId, groupId);
    setCreatingInGroup(groupId);
    setNewFileName('');
    setContextMenu(null);
  };

  const commitCreateFile = useCallback(() => {
    const name = newFileName.trim();
    if (name) createFile(name);
    setCreatingInGroup(null);
    setNewFileName('');
  }, [newFileName, createFile]);

  const toggleCollapse = (boardId: string) => {
    setCollapsed((prev) => ({ ...prev, [boardId]: !prev[boardId] }));
  };

  return (
    <div className="file-explorer">
      <div className="file-explorer-header">
        <span className="file-explorer-title">{t('editor.fileExplorer.workspace')}</span>
        <div className="file-explorer-header-actions">
          <button
            className="file-explorer-new-btn"
            title={t('editor.fileExplorer.newWorkspace')}
            onClick={onNewClick}
          >
            <IcoNewWorkspace />
          </button>
          <button
            className="file-explorer-save-btn"
            title="Open project (.vlx Velxio or .zip Wokwi)"
            onClick={handleOpenProjectClick}
          >
            <IcoOpen />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={PROJECT_FILE_ACCEPT}
            onChange={handleProjectFilePicked}
            style={{ display: 'none' }}
          />
          <button
            className="file-explorer-save-btn"
            title={t('editor.fileExplorer.saveProject')}
            onClick={onSaveClick}
          >
            <IcoSave />
          </button>
        </div>
      </div>

      <div className="file-explorer-list">
        {boards.map((board) => {
          const groupId = board.activeFileGroupId;
          const groupFiles = fileGroups[groupId] ?? [];
          const isActiveBoard = board.id === activeBoardId;
          const isOpen = !collapsed[board.id];
          const color = BOARD_COLOR[board.boardKind];

          // Status dot color
          const statusColor = board.running
            ? '#22c55e'
            : board.compiledProgram
              ? '#f59e0b'
              : '#6b7280';

          return (
            <div key={board.id} className="fe-board-section">
              {/* Board section header */}
              <div
                className={`fe-board-header${isActiveBoard ? ' fe-board-header-active' : ''}`}
                onClick={() => {
                  switchToBoard(board.id, groupId);
                  if (!isOpen) toggleCollapse(board.id);
                }}
                title={`${BOARD_KIND_LABELS[board.boardKind]} — ${t('editor.fileExplorer.clickToEdit')}`}
              >
                <button
                  className="fe-collapse-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapse(board.id);
                  }}
                  title={isOpen ? t('editor.fileExplorer.collapse') : t('editor.fileExplorer.expand')}
                >
                  <IcoChevron open={isOpen} />
                </button>

                <span className="fe-board-icon" style={{ color }}>
                  {BOARD_ICON[board.boardKind]}
                </span>

                <span className="fe-board-label">{BOARD_KIND_LABELS[board.boardKind]}</span>

                <span
                  className="fe-status-dot"
                  style={{ background: statusColor }}
                  title={
                    board.running
                      ? t('editor.fileExplorer.status.running')
                      : board.compiledProgram
                        ? t('editor.fileExplorer.status.compiled')
                        : t('editor.fileExplorer.status.idle')
                  }
                />

                {/* New file button — visible on hover */}
                <button
                  className="fe-board-new-btn"
                  title={t('editor.fileExplorer.newFileInBoard')}
                  onClick={(e) => {
                    e.stopPropagation();
                    startCreateFile(board.id, groupId);
                  }}
                >
                  <IcoNewFile />
                </button>
              </div>

              {/* Files under this board */}
              {isOpen && (
                <div className="fe-board-files">
                  {groupFiles.map((file) => {
                    const isActiveFile = isActiveBoard && file.id === activeFileId;
                    return (
                      <div
                        key={file.id}
                        className={`file-explorer-item fe-file-item${isActiveFile ? ' file-explorer-item-active' : ''}`}
                        onClick={() => handleFileClick(file.id, board.id, groupId)}
                        onContextMenu={(e) => handleContextMenu(e, file.id, groupId)}
                        onDoubleClick={() => {
                          switchToBoard(board.id, groupId);
                          startRename(file.id, groupId);
                        }}
                        title={`${file.name}${file.modified ? ` (${t('editor.fileExplorer.unsavedSuffix')})` : ''}`}
                      >
                        <span className="file-explorer-icon">
                          <FileIcon name={file.name} />
                        </span>

                        {renamingId === file.id ? (
                          <input
                            ref={renameInputRef}
                            className="file-explorer-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename();
                              if (e.key === 'Escape') setRenamingId(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <span className="file-explorer-name">{file.name}</span>
                        )}

                        {file.modified && (
                          <span className="file-explorer-dot" title={t('editor.fileExplorer.unsavedChanges')} />
                        )}
                      </div>
                    );
                  })}

                  {/* Inline new-file input for this group */}
                  {creatingInGroup === groupId && (
                    <div className="file-explorer-item file-explorer-item-new fe-file-item">
                      <span className="file-explorer-icon">
                        <IcoFile />
                      </span>
                      <input
                        ref={newFileInputRef}
                        className="file-explorer-rename-input"
                        value={newFileName}
                        placeholder="filename.ino"
                        onChange={(e) => setNewFileName(e.target.value)}
                        onBlur={commitCreateFile}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitCreateFile();
                          if (e.key === 'Escape') {
                            setCreatingInGroup(null);
                            setNewFileName('');
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Fallback: no boards yet */}
        {boards.length === 0 && (
          <div style={{ color: '#666', fontSize: 11, padding: '12px 12px', lineHeight: 1.5 }}>
            {t('editor.fileExplorer.emptyState')}
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          className="file-explorer-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => startRename(contextMenu.fileId, contextMenu.boardGroupId)}>
            {t('editor.fileExplorer.contextMenu.rename')}
          </button>
          <button
            className="ctx-delete"
            onClick={() => handleDelete(contextMenu.fileId, contextMenu.boardGroupId)}
            disabled={(fileGroups[contextMenu.boardGroupId] ?? []).length <= 1}
          >
            {t('editor.fileExplorer.contextMenu.delete')}
          </button>
        </div>
      )}
    </div>
  );
};
