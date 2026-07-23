import AutomationWorkflowService from '@baserow/modules/automation/services/workflow'

describe('Automation workflow service', () => {
  test('orders workflows through the automation-scoped source endpoint', async () => {
    const client = { post: vi.fn().mockResolvedValue({ data: null }) }
    const service = AutomationWorkflowService(client)

    await service.order(42, [9, 7, 8])

    expect(client.post).toHaveBeenCalledOnce()
    expect(client.post).toHaveBeenCalledWith(
      '/automation/42/workflows/order/',
      { workflow_ids: [9, 7, 8] }
    )
  })
})
