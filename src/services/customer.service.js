const { createContactService } = require('./contact.service');

const customers = createContactService('customers', 'Customer');

module.exports = {
  createCustomer: customers.create,
  getCustomer: customers.get,
  listCustomers: customers.list,
  updateCustomer: customers.update,
};
