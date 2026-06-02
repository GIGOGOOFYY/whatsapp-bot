const mongoose = require('mongoose')

async function connectDB() {

  try {

    mongoose.set(
      'strictQuery',
      false
    )

    await mongoose.connect(
      process.env.MONGO_URI,
      {
        serverSelectionTimeoutMS: 5000
      }
    )

    console.log(
      '✅ MongoDB Connected'
    )

  } catch (err) {

    console.log(
      '❌ MongoDB Connection Error'
    )

    console.log(err.message)

    process.exit(1)
  }
}

module.exports = connectDB