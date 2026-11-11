const { createContactService } = require('./contact.service');

const vendors = createContactService('vendors', 'Vendor');

module.exports = {
  createVendor: vendors.create,
  getVendor: vendors.get,
  listVendors: vendors.list,
  updateVendor: vendors.update,
};
