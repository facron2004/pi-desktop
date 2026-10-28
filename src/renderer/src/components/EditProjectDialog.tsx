import { useRef, useState } from 'react'
import { Folder, Plus, Trash2, X } from 'lucide-react'
import type { Project } from '../lib/projects'
import type { Workspace } from '@shared/types'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import { basename, samePath } from '../lib/path'
import { useAppStore } from '../store/useAppStore'
import '../styles/project-edit.css'

interface EditProjectDialogProps {
  project: Project
  onClose: () => void
}

export function EditProjectDialog({ project, onClose }: EditProjectDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, onClose)

  const t = useT()
  const showToast = useAppStore((state) => state.showToast)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const workspace = useAppStore((state) => state.workspace)

  const [name, setName] = useState(project.name)
  const [folders, setFolders] = useState<string[]>(() => {
    if (project.folders && project.folders.length > 0) {
      return [...project.folders]
    }
    return [project.path]
  })

  const handleAddFolder = async () => {
    const defaultPath = folders[0] ?? project.path
    const selected = await window.pi.dialog.pickDirectory(defaultPath)
    if (!selected) return

    if (folders.some((f) => samePath(f, selected))) {
      showToast(t('Folder is already in this project'))
      return
    }

    setFolders((prev) => [...prev, selected])
  }

  const handleRemoveFolder = (targetFolder: string) => {
    setFolders((prev) => prev.filter((f) => !samePath(f, targetFolder)))
  }

  const handleSetPrimary = (targetFolder: string) => {
    setFolders((prev) => {
      const remaining = prev.filter((f) => !samePath(f, targetFolder))
      return [targetFolder, ...remaining]
    })
  }

  const handleSave = async () => {
    if (folders.length === 0) {
      showToast(t('A project must have at least one folder'))
      return
    }

    const trimmedName = name.trim() || basename(folders[0]) || 'Project'
    const workspaces = (await window.pi.settings.get()).workspaces
    const existingIndex = workspaces.findIndex(
      (w) => w.id === project.id || samePath(w.path, project.path)
    )

    let updatedWorkspaces: Workspace[]
    if (existingIndex >= 0) {
      updatedWorkspaces = workspaces.map((w, idx) =>
        idx === existingIndex
          ? {
              ...w,
              name: trimmedName,
              path: folders[0],
              folders
            }
          : w
      )
    } else {
      const newWs: Workspace = {
        id: crypto.randomUUID(),
        name: trimmedName,
        path: folders[0],
        folders,
        lastOpenedAt: Date.now()
      }
      updatedWorkspaces = [newWs, ...workspaces]
    }

    await updateSettings({ workspaces: updatedWorkspaces })

    // Update active workspace in store if this project is currently active
    if (
      workspace &&
      (workspace.id === project.id || samePath(workspace.path, project.path))
    ) {
      useAppStore.setState({
        workspace: {
          ...workspace,
          name: trimmedName,
          path: folders[0],
          folders
        }
      })
    }

    showToast(t('Project updated'))
    onClose()
  }

  return (
    <div className="modal-layer" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal modal--project-edit"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-edit-title"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="project-edit-title" className="modal__title">
            {t('Edit project')}
          </h2>
          <button
            type="button"
            className="icon-btn modal__close"
            aria-label={t('Close')}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>

        <div className="project-edit__body">
          {/* Project name field */}
          <div className="project-edit__field">
            <label htmlFor="project-edit-name" className="project-edit__label">
              {t('Project name')}
            </label>
            <input
              id="project-edit-name"
              className="project-edit__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('Project name')}
              autoFocus
            />
          </div>

          {/* Folders management field */}
          <div className="project-edit__field">
            <div className="project-edit__field-head">
              <label className="project-edit__label">
                <span>{t('Project folders')}</span>
                <span className="project-edit__count">({folders.length})</span>
              </label>
              <button
                type="button"
                className="project-edit__add-btn"
                onClick={() => void handleAddFolder()}
              >
                <Plus size={13} />
                <span>{t('Add folder')}</span>
              </button>
            </div>

            {folders.length === 0 ? (
              <div className="project-edit__empty">
                {t('No folders in this project. Click "+ Add folder" above.')}
              </div>
            ) : (
              <div className="project-edit__folder-list">
                {folders.map((folderPath, index) => {
                  const isPrimary = index === 0
                  return (
                    <div className="project-edit__folder-item" key={folderPath}>
                      <div className="project-edit__folder-info">
                        <Folder size={16} className="project-edit__folder-icon" />
                        <div className="project-edit__folder-texts">
                          <div className="project-edit__folder-top">
                            <span className="project-edit__folder-name">
                              {basename(folderPath)}
                            </span>
                            {isPrimary ? (
                              <span className="project-edit__primary-chip">
                                {t('Primary')}
                              </span>
                            ) : null}
                          </div>
                          <span className="project-edit__folder-path" title={folderPath}>
                            {folderPath}
                          </span>
                        </div>
                      </div>

                      <div className="project-edit__folder-actions">
                        {!isPrimary ? (
                          <button
                            type="button"
                            className="project-edit__action-btn"
                            title={t('Set as primary')}
                            onClick={() => handleSetPrimary(folderPath)}
                          >
                            {t('Set as primary')}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="project-edit__delete-btn"
                          title={t('Remove folder')}
                          aria-label={t('Remove folder')}
                          onClick={() => handleRemoveFolder(folderPath)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <div className="modal__foot">
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void handleSave()}
            disabled={folders.length === 0}
          >
            {t('Save')}
          </button>
        </div>
      </div>
    </div>
  )
}
