import { ApplicationType } from '@baserow/modules/core/applicationTypes'
import Sidebar from '@baserow/modules/documents/components/Sidebar.vue'
import DocumentApplicationContext from '@baserow/modules/documents/components/DocumentApplicationContext.vue'

export class DocumentApplicationType extends ApplicationType {
    static getType() {
        return 'document'
    }

    getIconClass() {
        return 'iconoir-page'
    }

    getName() {
        const { $i18n: i18n } = this.app
        return i18n.t('applicationType.document') || 'Document'
    }

    getNamePlural() {
        const { $i18n: i18n } = this.app
        return i18n.t('applicationType.documents') || 'Documents'
    }

    getDescription() {
        const { $i18n: i18n } = this.app
        return i18n.t('applicationType.documentDesc') || 'Create pages and rich text documents.'
    }

    getDefaultName() {
        const { $i18n: i18n } = this.app
        return i18n.t('applicationType.documentDefaultName') || 'Document'
    }

    getSidebarComponent() {
        return Sidebar
    }

    getApplicationContextComponent() {
        return DocumentApplicationContext
    }

    getTemplateSidebarComponent() {
        return null
    }

    getTemplatesPageComponent() {
        return null
    }

    getOrder() {
        return 30
    }

    getDependentsName() {
        // Allows backend to populate dependents correctly if needed
        return ['page', 'pages']
    }

    getDependents(document) {
        return (document.pages || []).map((page) => {
            return {
                id: page.id,
                name: page.title || 'Sans titre',
            }
        })
    }

    populate(application) {
        return {
            ...super.populate(application),
            pages: (application.pages || []),
        }
    }

    prepareForStoreUpdate(application, data) {
        if (Object.prototype.hasOwnProperty.call(data, 'pages')) {
            delete data.pages
        }
        return data
    }

    async select(application, { $router, $store, $i18n }) {
        try {
            await $store.dispatch('documentPage/fetchAll', application.id)
        } catch (e) {
            // ignore fetch errors, continue
        }
        const pages = $store.getters['documentPage/getPages'].filter(
            (p) => p.document_id === application.id
        )
        if (pages.length > 0) {
            await $router.push({
                name: 'document-page',
                params: {
                    documentId: application.id,
                    pageId: pages[0].id,
                },
            })
            return true
        } else {
            // Auto-create a first page when the document is empty
            try {
                const newPage = await $store.dispatch('documentPage/create', {
                    documentId: application.id,
                    values: { title: 'Nouvelle page', parent_id: null },
                })
                await $router.push({
                    name: 'document-page',
                    params: {
                        documentId: application.id,
                        pageId: newPage.id,
                    },
                })
                return true
            } catch (e) {
                $store.dispatch('toast/error', {
                    title: 'Erreur',
                    message: 'Impossible de créer la page.',
                })
                return false
            }
        }
    }
}
