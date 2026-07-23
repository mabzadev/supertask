export const routeDefinitions = [
    {
        name: 'document',
        path: '/document/:documentId',
        componentFile: 'pages/page.vue',
    },
    {
        name: 'document-page',
        path: '/document/:documentId/page/:pageId',
        componentFile: 'pages/page.vue',
    },
]
