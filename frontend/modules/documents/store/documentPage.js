const state = () => ({
    pages: [],
    loadedDocumentIds: [],
})

const mutations = {
    SET_PAGES_FOR_DOCUMENT(state, { documentId, pages }) {
        state.pages = [
            ...state.pages.filter((p) => p.document_id !== documentId),
            ...pages,
        ]
        if (!state.loadedDocumentIds.includes(documentId)) {
            state.loadedDocumentIds.push(documentId)
        }
    },
    ADD_PAGE(state, page) {
        state.pages.push(page)
    },
    UPDATE_PAGE(state, updatedPage) {
        const index = state.pages.findIndex((p) => p.id === updatedPage.id)
        if (index !== -1) {
            state.pages.splice(index, 1, updatedPage)
        } else {
            state.pages.push(updatedPage)
        }
    },
    DELETE_PAGE(state, pageId) {
        state.pages = state.pages.filter((p) => p.id !== pageId)
    },
}

const actions = {
    async fetchAll({ commit }, documentId) {
        const { data } = await this.$client.get(`/document/${documentId}/pages/`)
        commit('SET_PAGES_FOR_DOCUMENT', { documentId, pages: data })
    },
    async fetch({ commit }, pageId) {
        const { data } = await this.$client.get(`/document/pages/${pageId}/`)
        commit('UPDATE_PAGE', data)
        return data
    },
    async create({ commit }, { documentId, values }) {
        const { data } = await this.$client.post(`/document/${documentId}/pages/`, values)
        commit('ADD_PAGE', data)
        return data
    },
    async update({ commit }, { pageId, values }) {
        const { data } = await this.$client.patch(`/document/pages/${pageId}/`, values)
        commit('UPDATE_PAGE', data)
        return data
    },
    async delete({ commit }, pageId) {
        await this.$client.delete(`/document/pages/${pageId}/`)
        commit('DELETE_PAGE', pageId)
    },
}

const getters = {
    getPages(state) {
        return state.pages
    },
    getPage: (state) => (id) => {
        return state.pages.find((p) => p.id === id)
    },
    isLoaded: (state) => (documentId) => {
        return state.loadedDocumentIds.includes(documentId)
    },
}

export default {
    namespaced: true,
    state,
    mutations,
    actions,
    getters,
}
