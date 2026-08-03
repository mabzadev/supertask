export default (client) => ({
  get() {
    return client.get('/admin/account-access/')
  },
  update(values) {
    return client.patch('/admin/account-access/', values)
  },
  searchUsers(search = '') {
    return client.get('/admin/users/', {
      params: { search, size: 20, sorts: 'username' },
    })
  },
})
