import { Extension } from '@tiptap/core'
import Suggestion from '@tiptap/suggestion'
import { VueRenderer } from '@tiptap/vue-3'
import tippy from 'tippy.js'

import SlashCommandList from '@baserow/modules/documents/components/SlashCommandList.vue'

const getSuggestionItems = ({ query }) => {
    return [
        {
            title: 'Texte',
            description: 'Commencez à écrire du texte simple.',
            icon: 'iconoir-text',
            command: ({ editor, range }) => {
                editor.chain().focus().deleteRange(range).setParagraph().run()
            },
        },
        {
            title: 'Titre 1',
            description: 'Grand titre de section.',
            icon: 'baserow-icon-heading-1',
            command: ({ editor, range }) => {
                editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run()
            },
        },
        {
            title: 'Titre 2',
            description: 'Titre de section moyen.',
            icon: 'baserow-icon-heading-2',
            command: ({ editor, range }) => {
                editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run()
            },
        },
        {
            title: 'Titre 3',
            description: 'Petit titre de section.',
            icon: 'baserow-icon-heading-3',
            command: ({ editor, range }) => {
                editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run()
            },
        },
        {
            title: 'Liste à puces',
            description: 'Créer une liste à puces.',
            icon: 'iconoir-list',
            command: ({ editor, range }) => {
                editor.chain().focus().deleteRange(range).toggleBulletList().run()
            },
        },
        {
            title: 'Liste numérotée',
            description: 'Créer une liste numérotée.',
            icon: 'baserow-icon-ordered-list',
            command: ({ editor, range }) => {
                editor.chain().focus().deleteRange(range).toggleOrderedList().run()
            },
        },
        {
            title: 'Liste de tâches',
            description: 'Suivre les éléments à faire.',
            icon: 'iconoir-task-list',
            command: ({ editor, range }) => {
                editor.chain().focus().deleteRange(range).toggleTaskList().run()
            },
        },
        {
            title: 'Code',
            description: 'Insérer un extrait de code.',
            icon: 'iconoir-code',
            command: ({ editor, range }) => {
                editor.chain().focus().deleteRange(range).setCodeBlock().run()
            },
        },
        {
            title: 'Séparateur',
            description: 'Séparer visuellement les blocs.',
            icon: 'iconoir-border-bottom',
            command: ({ editor, range }) => {
                editor.chain().focus().deleteRange(range).setHorizontalRule().run()
            },
        },
        {
            title: 'Citation',
            description: 'Mettre une citation en valeur.',
            icon: 'iconoir-quote',
            command: ({ editor, range }) => {
                editor.chain().focus().deleteRange(range).setBlockquote().run()
            },
        },
        {
            title: 'Table',
            description: 'Insérer un tableau.',
            icon: 'iconoir-table',
            command: ({ editor, range }) => {
                editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
            },
        },
        {
            title: 'Vidéo YouTube',
            description: 'Intégrer une vidéo YouTube.',
            icon: 'iconoir-youtube',
            command: ({ editor, range }) => {
                const url = prompt('Adresse de la vidéo YouTube :')
                if (url) {
                    editor.chain().focus().deleteRange(range).setYoutubeVideo({ src: url }).run()
                } else {
                    editor.chain().focus().deleteRange(range).run()
                }
            },
        },
        {
            title: 'Image',
            description: 'Insérer une image depuis une adresse.',
            icon: 'iconoir-media-image',
            command: ({ editor, range }) => {
                const url = prompt('Adresse de l’image :')
                if (url) {
                    editor.chain().focus().deleteRange(range).setImage({ src: url }).run()
                } else {
                    editor.chain().focus().deleteRange(range).run()
                }
            },
        },
        {
            title: 'Encadré',
            description: 'Mettre une information en évidence.',
            icon: 'iconoir-info-empty',
            command: ({ editor, range }) => {
                editor.chain().focus().deleteRange(range).setCallout().run()
            },
        },
        {
            title: 'Table des matières',
            description: 'Insérer une table des matières.',
            icon: 'iconoir-list',
            command: ({ editor, range }) => {
                editor.chain().focus().deleteRange(range).insertTableOfContents().run()
            },
        },
        {
            title: 'Vue de données',
            description: 'Intégrer une grille ou une galerie publique.',
            icon: 'iconoir-database-monitor',
            command: ({ editor, range }) => {
                const url = prompt('Lien public de la vue :')
                if (url) {
                    editor.chain().focus().deleteRange(range).setEmbeddedView({ src: url }).run()
                } else {
                    editor.chain().focus().deleteRange(range).run()
                }
            },
        },
        {
            title: 'Valeur dynamique',
            description: 'Lier le texte à la valeur d’une cellule.',
            icon: 'iconoir-link',
            command: ({ editor, range }) => {
                const text = prompt('Nom de la variable :')
                if (text) {
                    editor.chain().focus().deleteRange(range).insertDynamicLookup({ fallbackText: text }).run()
                } else {
                    editor.chain().focus().deleteRange(range).run()
                }
            },
        },
        {
            title: 'Fichier audio',
            description: 'Insérer un contenu audio depuis une adresse.',
            icon: 'iconoir-music-note',
            command: ({ editor, range }) => {
                const url = prompt('Adresse du fichier audio (par ex. .mp3) :')
                if (url) {
                    editor.chain().focus().deleteRange(range).setAudio({ src: url }).run()
                } else {
                    editor.chain().focus().deleteRange(range).run()
                }
            },
        },
        {
            title: 'Section repliable',
            description: 'Ajouter une section que l’on peut replier.',
            icon: 'iconoir-nav-arrow-right',
            command: ({ editor, range }) => {
                editor.chain().focus().deleteRange(range).setDetails().run()
            },
        },
    ]
        .filter((item) =>
            item.title.toLowerCase().startsWith(query.toLowerCase())
        )
        .slice(0, 10)
}

const renderItems = () => {
    let component
    let popup

    return {
        onStart: (props) => {
            component = new VueRenderer(SlashCommandList, {
                props,
                editor: props.editor,
            })

            if (!props.clientRect) {
                return
            }

            popup = tippy('body', {
                getReferenceClientRect: props.clientRect,
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: 'manual',
                placement: 'bottom-start',
                offset: [0, 5],
            })
        },

        onUpdate(props) {
            component.updateProps(props)

            if (!props.clientRect) {
                return
            }

            popup[0].setProps({
                getReferenceClientRect: props.clientRect,
            })
        },

        onKeyDown(props) {
            if (props.event.key === 'Escape') {
                popup[0].hide()
                return true
            }
            return component.ref?.onKeyDown(props)
        },

        onExit() {
            popup[0].destroy()
            component.destroy()
        },
    }
}

export const SlashCommand = Extension.create({
    name: 'slashCommand',

    addOptions() {
        return {
            suggestion: {
                char: '/',
                command: ({ editor, range, props }) => {
                    props.command({ editor, range })
                },
            },
        }
    },

    addProseMirrorPlugins() {
        return [
            Suggestion({
                editor: this.editor,
                ...this.options.suggestion,
                items: getSuggestionItems,
                render: renderItems,
            }),
        ]
    },
})
