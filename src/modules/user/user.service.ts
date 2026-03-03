import { Injectable } from '@nestjs/common';
import { UserRepository } from '../../repositories/user.repository';
import { CreateUserDto } from './dto/createUser.dto';

@Injectable()
export class UserService {
    constructor(private readonly userRepository: UserRepository) {}

    async findOrCreateUser(createUserDto: CreateUserDto) {
        return await this.userRepository.findOrCreateUser(createUserDto);
    }
}
