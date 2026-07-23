const state = () => ({ canvases: [], loaded: [] })

const mutations = {
  SET(state, { whiteboardId, canvases }) {
    state.canvases = [...state.canvases.filter((item) => item.whiteboard_id !== whiteboardId), ...canvases]
    if (!state.loaded.includes(whiteboardId)) state.loaded.push(whiteboardId)
  },
  UPSERT(state, canvas) {
    const index = state.canvases.findIndex((item) => item.id === canvas.id)
    if (index === -1) state.canvases.push(canvas)
    else state.canvases.splice(index, 1, canvas)
  },
  REMOVE(state, id) { state.canvases = state.canvases.filter((item) => item.id !== id) },
}

const actions = {
  async fetchAll({ commit }, whiteboardId) {
    const { data } = await this.$client.get(`/whiteboards/${whiteboardId}/canvases/`)
    commit('SET', { whiteboardId, canvases: data })
    return data
  },
  async fetch({ commit }, id) {
    const { data } = await this.$client.get(`/whiteboards/canvases/${id}/`)
    commit('UPSERT', data)
    return data
  },
  async create({ commit }, { whiteboardId, values }) {
    const { data } = await this.$client.post(`/whiteboards/${whiteboardId}/canvases/`, values)
    commit('UPSERT', data)
    return data
  },
  async update({ commit }, { id, values }) {
    const { data } = await this.$client.patch(`/whiteboards/canvases/${id}/`, values)
    commit('UPSERT', data)
    return data
  },
  async duplicate({ commit }, id) {
    const { data } = await this.$client.post(`/whiteboards/canvases/${id}/duplicate/`)
    commit('UPSERT', data)
    return data
  },
  async delete({ commit }, id) {
    await this.$client.delete(`/whiteboards/canvases/${id}/`)
    commit('REMOVE', id)
  },
}

const getters = {
  all: (state) => state.canvases,
  byWhiteboard: (state) => (id) => state.canvases.filter((item) => item.whiteboard_id === id).sort((a, b) => a.order - b.order),
  get: (state) => (id) => state.canvases.find((item) => item.id === id),
  isLoaded: (state) => (id) => state.loaded.includes(id),
}

export default { namespaced: true, state, mutations, actions, getters }
